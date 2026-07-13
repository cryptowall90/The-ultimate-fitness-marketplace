import type pg from "pg";
import {
  UPLOAD_KINDS,
  type UploadKind,
  generateObjectKey,
  validateUpload,
  type MediaStorageProvider,
} from "@fitmarket/media";

const UPLOAD_URL_TTL_SECONDS = 300;
const DEFAULT_QUOTA_BYTES = 524_288_000; // matches the seeded system setting

export class MediaUploadError extends Error {
  constructor(
    public readonly code:
      | "type_not_allowed"
      | "too_large"
      | "quota_exceeded"
      | "upload_not_found"
      | "verification_failed",
    message: string,
  ) {
    super(message);
  }
}

export interface RequestUploadResult {
  mediaId: string;
  upload: {
    url: string;
    method: string;
    headers: Record<string, string>;
    maxBytes: number;
    expiresAt: string;
  };
}

/**
 * Issues a one-time signed upload for an authenticated user. The declared
 * type/size are a pre-check only — nothing is trusted until the uploaded
 * bytes are verified in completeUpload. Object keys are random; the user's
 * filename is display metadata.
 */
export async function requestUpload(
  pool: pg.Pool,
  storage: MediaStorageProvider,
  buckets: { public: string; private: string },
  input: {
    ownerId: string;
    kind: UploadKind;
    contentType: string;
    byteSize: number;
    originalFilename?: string;
  },
): Promise<RequestUploadResult> {
  const policy = UPLOAD_KINDS[input.kind];
  if (!policy.allowedMime.includes(input.contentType)) {
    throw new MediaUploadError("type_not_allowed", "File type is not allowed for this upload");
  }
  if (input.byteSize > policy.maxBytes) {
    throw new MediaUploadError("too_large", "File exceeds the maximum size for this upload");
  }

  const quotaRes = await pool.query(
    `select coalesce((select (value)::bigint from system_settings
                      where key = 'uploads.per_user_quota_bytes'), $2) as quota,
            coalesce((select sum(byte_size) from media_objects
                      where owner_id = $1 and status <> 'deleted'), 0) as used`,
    [input.ownerId, DEFAULT_QUOTA_BYTES],
  );
  const { quota, used } = quotaRes.rows[0];
  if (Number(used) + input.byteSize > Number(quota)) {
    throw new MediaUploadError("quota_exceeded", "Storage quota exceeded");
  }

  const bucket = policy.bucketClass === "public" ? buckets.public : buckets.private;
  const objectKey = generateObjectKey(policy.keyPrefix);
  const row = await pool.query(
    `insert into media_objects
       (owner_id, provider, bucket, object_key, visibility, status, mime_type,
        byte_size, original_filename)
     values ($1, $2, $3, $4, $5, 'pending_upload', $6, $7, $8)
     returning id`,
    [
      input.ownerId,
      storage.name,
      bucket,
      objectKey,
      policy.visibility,
      input.contentType,
      input.byteSize,
      input.originalFilename ?? null,
    ],
  );

  const signed = await storage.createSignedUpload({
    bucket,
    objectKey,
    contentType: input.contentType,
    maxBytes: policy.maxBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });

  return {
    mediaId: row.rows[0].id,
    upload: {
      url: signed.url,
      method: signed.method,
      headers: signed.headers,
      maxBytes: signed.maxBytes,
      expiresAt: signed.expiresAt.toISOString(),
    },
  };
}

/**
 * Verifies the uploaded bytes (magic-byte sniff must match the declared
 * type) and advances the pipeline: images publish immediately; documents
 * wait in quarantine for the scan job. Failed verification rejects the row
 * and deletes the object.
 */
export async function completeUpload(
  pool: pg.Pool,
  storage: MediaStorageProvider,
  input: { ownerId: string; mediaId: string },
): Promise<{ mediaId: string; status: string }> {
  const rowRes = await pool.query(
    `select id, bucket, object_key, mime_type, visibility from media_objects
     where id = $1 and owner_id = $2 and status = 'pending_upload'`,
    [input.mediaId, input.ownerId],
  );
  const row = rowRes.rows[0];
  if (!row) throw new MediaUploadError("upload_not_found", "Upload not found");

  const kind: UploadKind = row.visibility === "private_document" ? "credential_document" : "avatar";
  const policy = UPLOAD_KINDS[kind];

  let bytes: Uint8Array;
  try {
    bytes = await storage.getObject({
      bucket: row.bucket,
      objectKey: row.object_key,
      maxBytes: policy.maxBytes,
    });
  } catch {
    throw new MediaUploadError("upload_not_found", "Uploaded object could not be read");
  }

  const verdict = validateUpload({
    bytes,
    declaredMime: row.mime_type,
    kind: policy.kind,
  });
  if (!verdict.ok) {
    await pool.query(
      `update media_objects set status = 'rejected', quarantine_reason = $2 where id = $1`,
      [row.id, verdict.reason],
    );
    await storage.deleteObject({ bucket: row.bucket, objectKey: row.object_key }).catch(() => {});
    throw new MediaUploadError("verification_failed", "Uploaded file failed verification");
  }

  const status = policy.publishOnVerify ? "published" : "quarantined";
  await pool.query(
    `update media_objects
     set status = $2::public.media_status, byte_size = $3, uploaded_at = now(),
         published_at = case when $2::text = 'published' then now() end
     where id = $1`,
    [row.id, status, bytes.byteLength],
  );
  return { mediaId: row.id, status };
}
