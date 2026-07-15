import { createHash } from "node:crypto";
import type pg from "pg";
import type { MediaStorageProvider } from "@fitmarket/media";
import {
  ALLOWED_DOCUMENT_MIME,
  ALLOWED_IMAGE_MIME,
  MAX_DOCUMENT_BYTES,
  MAX_UPLOAD_BYTES,
  generateObjectKey,
  validateUpload,
} from "@fitmarket/media";
import type { MediaUploadKind } from "@fitmarket/validation";
import { withTransaction } from "../db.js";

/**
 * Signed-upload flow (docs/MEDIA_PIPELINE.md):
 *  1. create: quota + type checks, random object key, media row in
 *     pending_upload, one-time signed URL back to the client.
 *  2. client PUTs the bytes directly to storage.
 *  3. finalize: server reads the object back, verifies magic bytes against the
 *     declared type (SVG/polyglots rejected), records size + sha256 and moves
 *     the row to 'quarantined' — publication stays a separate server-managed
 *     step (scan / re-encode worker), never a client transition.
 */

export class MediaUploadError extends Error {
  constructor(
    readonly code:
      | "unsupported_type"
      | "too_large"
      | "quota_exceeded"
      | "too_many_pending"
      | "not_found"
      | "not_uploaded",
    message: string,
  ) {
    super(message);
  }
}

interface KindConfig {
  visibility: "public_profile" | "private_document";
  bucket: string;
  prefix: "public" | "documents";
  allowedMime: readonly string[];
  maxBytes: number;
}

export const MEDIA_BUCKETS = {
  public: "public-media",
  private: "private-media",
} as const;

const KIND_CONFIG: Record<MediaUploadKind, KindConfig> = {
  avatar: {
    visibility: "public_profile",
    bucket: MEDIA_BUCKETS.public,
    prefix: "public",
    allowedMime: ALLOWED_IMAGE_MIME,
    maxBytes: MAX_UPLOAD_BYTES,
  },
  credential_document: {
    visibility: "private_document",
    bucket: MEDIA_BUCKETS.private,
    prefix: "documents",
    allowedMime: [...ALLOWED_IMAGE_MIME, ...ALLOWED_DOCUMENT_MIME],
    maxBytes: MAX_DOCUMENT_BYTES,
  },
};

const MAX_PENDING_UPLOADS = 10;
const UPLOAD_URL_TTL_SECONDS = 300;
const DEFAULT_QUOTA_BYTES = 524_288_000; // 500 MB, matches seeded system_settings

export interface CreateSignedUploadInput {
  userId: string;
  kind: MediaUploadKind;
  declaredMime: string;
  byteSize: number;
  originalFilename?: string | undefined;
}

export interface CreateSignedUploadResult {
  mediaId: string;
  upload: {
    url: string;
    method: "PUT" | "POST";
    headers: Record<string, string>;
    expiresAt: string;
    maxBytes: number;
  };
}

export async function createSignedUpload(
  pool: pg.Pool,
  provider: MediaStorageProvider,
  input: CreateSignedUploadInput,
): Promise<CreateSignedUploadResult> {
  const config = KIND_CONFIG[input.kind];
  if (!config.allowedMime.includes(input.declaredMime)) {
    throw new MediaUploadError("unsupported_type", "File type not allowed for this upload kind");
  }
  if (input.byteSize > config.maxBytes) {
    throw new MediaUploadError("too_large", "File exceeds the maximum size for this upload kind");
  }

  const usage = await pool.query(
    `select coalesce(sum(byte_size), 0)::bigint as used_bytes,
            count(*) filter (where status = 'pending_upload') as pending_count
     from media_objects
     where owner_id = $1 and status <> 'deleted'`,
    [input.userId],
  );
  const pendingCount = Number(usage.rows[0].pending_count);
  if (pendingCount >= MAX_PENDING_UPLOADS) {
    throw new MediaUploadError(
      "too_many_pending",
      "Too many uploads in progress; finish or abandon existing uploads first",
    );
  }
  const quotaRes = await pool.query(
    `select value from system_settings where key = 'uploads.per_user_quota_bytes'`,
  );
  const quotaBytes = Number(quotaRes.rows[0]?.value ?? DEFAULT_QUOTA_BYTES);
  if (Number(usage.rows[0].used_bytes) + input.byteSize > quotaBytes) {
    throw new MediaUploadError("quota_exceeded", "Storage quota exceeded");
  }

  const objectKey = generateObjectKey(config.prefix);
  const inserted = await pool.query(
    `insert into media_objects
       (owner_id, provider, bucket, object_key, visibility, status, mime_type, byte_size, original_filename)
     values ($1, $2, $3, $4, $5, 'pending_upload', $6, $7, $8)
     returning id`,
    [
      input.userId,
      provider.name,
      config.bucket,
      objectKey,
      config.visibility,
      input.declaredMime,
      input.byteSize,
      input.originalFilename ?? null,
    ],
  );
  const signed = await provider.createSignedUpload({
    bucket: config.bucket,
    objectKey,
    contentType: input.declaredMime,
    maxBytes: Math.min(input.byteSize, config.maxBytes),
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
  return {
    mediaId: inserted.rows[0].id,
    upload: {
      url: signed.url,
      method: signed.method,
      headers: signed.headers,
      expiresAt: signed.expiresAt.toISOString(),
      maxBytes: signed.maxBytes,
    },
  };
}

export interface FinalizeUploadResult {
  mediaId: string;
  status: "quarantined" | "rejected";
  reason?: string;
}

export async function finalizeUpload(
  pool: pg.Pool,
  provider: MediaStorageProvider,
  input: { userId: string; mediaId: string },
): Promise<FinalizeUploadResult> {
  return withTransaction(pool, async (tx) => {
    const rowRes = await tx.query(
      `select id, bucket, object_key, mime_type
       from media_objects
       where id = $1 and owner_id = $2 and status = 'pending_upload'
       for update`,
      [input.mediaId, input.userId],
    );
    const row = rowRes.rows[0];
    if (!row) {
      throw new MediaUploadError("not_found", "Upload not found or already finalized");
    }

    const bytes = await provider.getObjectBytes({ bucket: row.bucket, objectKey: row.object_key });
    if (!bytes || bytes.byteLength === 0) {
      throw new MediaUploadError("not_uploaded", "No uploaded object found for this media id");
    }

    const kind = row.mime_type === "application/pdf" ? "document" : "image";
    const verdict = validateUpload({ bytes, declaredMime: row.mime_type, kind });
    if (!verdict.ok) {
      await tx.query(
        `update media_objects set status = 'rejected', quarantine_reason = $2 where id = $1`,
        [row.id, verdict.reason],
      );
      // Remove the offending object; the row keeps the audit trail.
      await provider.deleteObject({ bucket: row.bucket, objectKey: row.object_key });
      return { mediaId: row.id, status: "rejected", reason: verdict.reason };
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await tx.query(
      `update media_objects
       set status = 'quarantined', uploaded_at = now(), byte_size = $2, sha256 = $3
       where id = $1`,
      [row.id, bytes.byteLength, sha256],
    );
    return { mediaId: row.id, status: "quarantined" };
  });
}
