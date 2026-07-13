import { z } from "zod";
import { parseEnv } from "@fitmarket/config/env";

/** Validated at startup; the process refuses to boot without required secrets. */
export interface ApiEnv {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATABASE_URL: string;
  SUPABASE_JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** bearer token authenticating scheduled-job invocations */
  JOB_TOKEN: string;
  /** comma-separated CORS allowlist */
  ALLOWED_ORIGINS: string;
  APP_BASE_URL: string;
  /** Supabase project URL for Storage (optional until media is configured) */
  SUPABASE_URL?: string | undefined;
  /** Storage service-role key — server-only, never in client bundles */
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
  /** bucket names for public-profile vs private media */
  MEDIA_BUCKET_PUBLIC: string;
  MEDIA_BUCKET_PRIVATE: string;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const raw = parseEnv(
    {
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      PORT: z.coerce.number().int().min(1).max(65535).default(8787),
      DATABASE_URL: z.string().url(),
      SUPABASE_JWT_SECRET: z.string().min(20),
      STRIPE_SECRET_KEY: z.string().min(20),
      STRIPE_WEBHOOK_SECRET: z.string().min(10),
      JOB_TOKEN: z.string().min(32),
      ALLOWED_ORIGINS: z.string().min(1),
      APP_BASE_URL: z.string().url(),
      SUPABASE_URL: z.string().url().optional(),
      SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
      MEDIA_BUCKET_PUBLIC: z.string().min(1).default("public-media"),
      MEDIA_BUCKET_PRIVATE: z.string().min(1).default("private-media"),
    },
    source,
  );
  return raw;
}
