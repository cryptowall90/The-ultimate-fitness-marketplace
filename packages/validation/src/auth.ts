import { z } from "zod";
import { displayName, email, password } from "./primitives.js";

export const registerSchema = z
  .object({
    email,
    password,
    displayName,
    acceptedTermsVersionId: z.string().uuid(),
    // Cloudflare Turnstile token, verified server-side on abuse-prone flows.
    turnstileToken: z.string().min(1).max(2048).optional(),
    // Honeypot: must stay empty. Bots that fill it are rejected silently.
    website: z.literal("").optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(128),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const passwordResetRequestSchema = z.object({ email }).strict();

export const passwordResetSchema = z
  .object({
    password,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
