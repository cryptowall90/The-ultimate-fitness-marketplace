import { z } from "zod";
import { currencyCode, moneyCents, shortText, slug } from "./primitives.js";

export const durationUnitSchema = z.enum(["day", "week", "month"]);

export const programCreateSchema = z
  .object({
    slug,
    title: shortText(140, 3),
    summary: shortText(500),
    fullDescription: shortText(20000),
    deliveryMode: z.enum(["online", "in_person", "hybrid"]),
    pricingType: z.enum(["one_time", "recurring"]),
    priceCents: moneyCents,
    currency: currencyCode.default("usd"),
    durationValue: z.number().int().min(1).max(730),
    durationUnit: durationUnitSchema,
    recurrenceInterval: durationUnitSchema.optional(),
    recurrenceIntervalCount: z.number().int().min(1).max(12).optional(),
    capacity: z.number().int().min(1).max(10000).optional(),
    approvalPolicy: z.enum(["automatic", "manual"]).default("automatic"),
    includedFeatures: z.array(shortText(200)).max(20).default([]),
    cancellationTerms: shortText(4000),
    refundPolicy: shortText(4000),
    visibility: z.enum(["public", "unlisted"]).default("public"),
  })
  .strict()
  .refine(
    (p) =>
      p.pricingType !== "recurring" ||
      (p.recurrenceInterval !== undefined && p.recurrenceIntervalCount !== undefined),
    { message: "recurring programs require recurrence configuration" },
  );

export const programUpdateSchema = programCreateSchema.innerType().partial().strict();

export const programStatusTransitionSchema = z
  .object({
    to: z.enum(["published", "paused", "archived"]),
  })
  .strict();
