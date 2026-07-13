import { z } from "zod";
import { shortText, uuid } from "./primitives.js";

export const reviewCreateSchema = z
  .object({
    enrollmentId: uuid,
    // Integer 1–5 only; anything else is rejected before it reaches the DB
    // (which enforces the same constraint).
    rating: z.number().int().min(1).max(5),
    comment: shortText(4000).optional(),
  })
  .strict();

export const reviewUpdateSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    comment: shortText(4000).nullable().optional(),
  })
  .strict();

export const trainerResponseSchema = z
  .object({
    response: shortText(2000, 1),
  })
  .strict();

export const reviewReportSchema = z
  .object({
    reviewId: uuid,
    reason: shortText(1000, 3),
  })
  .strict();
