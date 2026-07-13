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
