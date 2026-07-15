import { z } from "zod";
import { shortText, uuid } from "./primitives.js";

/**
 * Privileged admin inputs. `.strict()` everywhere: unknown keys on privileged
 * payloads are rejected (mass-assignment protection).
 */

export const trainerApplicationDecisionSchema = z
  .object({
    trainerId: uuid,
    decision: z.enum(["approved", "rejected"]),
    /** Required audit reason, stored in admin_actions. */
    reason: shortText(2000, 3),
  })
  .strict();

export const trainerApplicationListSchema = z
  .object({
    status: z.enum(["submitted", "under_review"]).default("submitted"),
  })
  .strict();
