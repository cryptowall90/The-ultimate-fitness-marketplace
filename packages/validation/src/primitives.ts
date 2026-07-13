import { z } from "zod";

export const uuid = z.string().uuid();

/** Integer minor currency units. Never floats. */
export const moneyCents = z.number().int().min(0).max(100_000_000);

export const currencyCode = z
  .string()
  .length(3)
  .regex(/^[a-z]{3}$/i)
  .transform((s) => s.toLowerCase());

export const email = z.string().trim().toLowerCase().email().max(254);

/**
 * Password policy: length-based (NIST 800-63B). No composition rules that
 * push users toward predictable substitutions.
 */
export const password = z.string().min(10).max(128);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // reject control characters; text is rendered escaped, never as HTML
  .refine((s) => !CONTROL_CHARS.test(s), "invalid characters");

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,60}$/);

export const shortText = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), "invalid characters");

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);

/** Cursor tokens are opaque base64url strings with a bounded length. */
export const cursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/)
  .optional();

export const pageLimit = z.number().int().min(1).max(50).default(20);

export const isoTimestamp = z.string().datetime({ offset: true });
