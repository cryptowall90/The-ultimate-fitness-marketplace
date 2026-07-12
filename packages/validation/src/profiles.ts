import { z } from "zod";
import { displayName, shortText, slug, uuid } from "./primitives.js";

export const updateProfileSchema = z
  .object({
    displayName: displayName.optional(),
    bio: shortText(4000).optional(),
    timezone: shortText(64).optional(),
    avatarMediaId: uuid.nullable().optional(),
  })
  .strict();

export const updateClientProfileSchema = z
  .object({
    fitnessGoals: shortText(4000).optional(),
    preferredTrainingStyle: shortText(500).optional(),
    generalAvailability: shortText(1000).optional(),
  })
  .strict();

export const serviceModeSchema = z.enum(["online", "in_person", "hybrid"]);

export const trainerApplicationSchema = z
  .object({
    slug,
    headline: shortText(140, 10),
    about: shortText(8000, 50),
    serviceMode: serviceModeSchema,
    yearsExperience: z.number().int().min(0).max(80),
    languages: z.array(shortText(40)).min(1).max(10),
    businessName: shortText(200).optional(),
    specialtyIds: z.array(uuid).min(1).max(10),
  })
  .strict();

export const trainerServiceLocationSchema = z
  .object({
    cityName: shortText(120, 1),
    region: shortText(120).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    serviceRadiusKm: z.number().min(1).max(160),
    isPrimary: z.boolean().default(false),
    // Exact location is optional and stays private; public point is derived
    // from server-side geocoding of the city, never from the client.
    exactAddress: shortText(500).optional(),
  })
  .strict();

export const credentialSchema = z
  .object({
    title: shortText(200, 2),
    issuingOrganization: shortText(200, 2),
    issuedAt: z.string().date().optional(),
    expiresAt: z.string().date().optional(),
    documentMediaId: uuid.optional(),
  })
  .strict();
