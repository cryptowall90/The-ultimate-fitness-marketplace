import { z } from "zod";
import { shortText, uuid } from "./primitives.js";

/**
 * Media signed-upload requests. The declared MIME type is a client claim only:
 * the server re-verifies real content with magic bytes before the object can
 * leave pending_upload (see @fitmarket/media validateUpload).
 */

export const mediaUploadKindSchema = z.enum(["avatar", "credential_document"]);
export type MediaUploadKind = z.infer<typeof mediaUploadKindSchema>;

export const createSignedUploadSchema = z
  .object({
    kind: mediaUploadKindSchema,
    declaredMime: z.enum([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "application/pdf",
    ]),
    byteSize: z.number().int().min(1).max(10_485_760), // absolute cap; per-kind caps enforced server-side
    /** Display metadata only — never used as a storage path. */
    originalFilename: shortText(255).optional(),
  })
  .strict();

export const finalizeUploadSchema = z
  .object({
    mediaId: uuid,
  })
  .strict();
