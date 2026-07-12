import { z } from "zod";

/**
 * Environment validation helper. Every runtime validates its environment at startup
 * and fails fast (fail-secure) when a required server secret is missing.
 *
 * Public variables (safe for client bundles) MUST be prefixed:
 *   - web:    NEXT_PUBLIC_
 *   - mobile: EXPO_PUBLIC_
 * Server-only variables must never use those prefixes.
 */
export function parseEnv<T extends z.ZodRawShape>(
  shape: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<z.ZodObject<T>> {
  const schema = z.object(shape);
  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    // Never echo values — names and messages only.
    throw new Error(`Environment validation failed — ${missing}`);
  }
  return result.data;
}

export const serverEnvShapes = {
  databaseUrl: z.string().url(),
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(20),
  supabaseJwtSecret: z.string().min(20),
  stripeSecretKey: z.string().min(20),
  stripeWebhookSecret: z.string().min(10),
} as const;
