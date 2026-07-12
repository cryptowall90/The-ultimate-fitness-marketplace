import { z } from "zod";
import { uuid } from "./primitives.js";

export const createCheckoutSchema = z
  .object({
    programId: uuid,
    requestedStartAt: z.string().datetime({ offset: true }).optional(),
    // Amounts/prices are NEVER accepted from the client; the server reads the
    // published program version. `.strict()` rejects injected fields
    // (mass-assignment protection).
  })
  .strict();

export const refundRequestSchema = z
  .object({
    orderId: uuid,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
