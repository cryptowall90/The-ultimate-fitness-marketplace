import { z } from "zod";
import { cursor, latitude, longitude, pageLimit, shortText, slug } from "./primitives.js";

/** Radii offered in the UI (miles), converted to km server-side. */
export const RADIUS_MILES_OPTIONS = [5, 10, 15, 25, 50, 100] as const;
export const MAX_RADIUS_KM = 160;

export const inPersonSearchSchema = z
  .object({
    // The client sends a city query; the SERVER geocodes it. Direct
    // coordinates are also accepted (e.g. map pan) but radius stays capped.
    city: shortText(120).optional(),
    lat: latitude.optional(),
    lng: longitude.optional(),
    radiusKm: z.number().min(1).max(MAX_RADIUS_KM).default(40),
    specialty: slug.optional(),
    minRating: z.number().min(1).max(5).optional(),
    limit: pageLimit,
    cursor,
  })
  .strict()
  .refine((s) => s.city !== undefined || (s.lat !== undefined && s.lng !== undefined), {
    message: "either city or coordinates are required",
  });

export const onlineSearchSchema = z
  .object({
    q: shortText(120).optional(),
    specialty: slug.optional(),
    language: shortText(40).optional(),
    minRating: z.number().min(1).max(5).optional(),
    limit: pageLimit,
    cursor,
  })
  .strict();
