import type { MiddlewareHandler } from "hono";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token bucket. Suitable for a single-instance modular monolith;
 * Cloudflare provides the edge-level rate limiting in front (docs/SECURITY.md).
 * The interface stays the same if a durable store (e.g. Postgres/Redis) is
 * swapped in for multi-instance deployments.
 */
export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys = 50_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        // bounded memory: drop the oldest entries wholesale
        this.buckets.clear();
      }
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export function rateLimit(limiter: TokenBucketLimiter, keyBy: "ip" | "user"): MiddlewareHandler {
  return async (c, next) => {
    const key =
      keyBy === "user"
        ? (c.get("user")?.userId ??
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
          "anonymous")
        : (c.req.header("cf-connecting-ip") ??
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown");
    if (!limiter.allow(`${keyBy}:${key}`)) {
      c.header("Retry-After", "30");
      return c.json({ error: { code: "rate_limited", message: "Too many requests" } }, 429);
    }
    await next();
  };
}
