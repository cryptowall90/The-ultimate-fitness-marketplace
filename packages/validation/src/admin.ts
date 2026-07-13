import { z } from "zod";
import { shortText, uuid } from "./primitives.js";

/**
 * Admin decision on a submitted trainer application. A reason is always
 * required — it is written verbatim to the immutable admin_actions audit
 * trail (and, for rejections, shown to the applicant).
 */
export const adminTrainerDecisionSchema = z
  .object({
    trainerId: uuid,
    reason: shortText(2000, 3),
  })
  .strict();

/**
 * Moderator decision on a report. `removeContent` additionally removes the
 * reported content (supported for review and message targets); every decision
 * writes an admin_actions row.
 */
export const moderationDecisionSchema = z
  .object({
    reportId: uuid,
    reason: shortText(2000, 3),
    removeContent: z.boolean().default(false),
  })
  .strict();

/**
 * Signed-upload request. Size/mime limits here are a first check only —
 * the server re-enforces per-kind policy and verifies the actual bytes
 * (magic-byte sniffing) after upload, before anything is published.
 */
export const mediaUploadRequestSchema = z
  .object({
    kind: z.enum(["avatar", "credential_document"]),
    contentType: shortText(100, 3),
    byteSize: z.number().int().min(1).max(10_485_760),
    originalFilename: shortText(255).optional(),
  })
  .strict();
