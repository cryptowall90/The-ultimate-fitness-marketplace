import type { MiddlewareHandler } from "hono";
import type pg from "pg";
import type { Logger } from "@fitmarket/observability";

export interface RateLimiter {
  /** True when the request may proceed (one token consumed). */
  allow(key: string): boolean | Promise<boolean>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token bucket: first line of defense for cheap, high-volume
 * per-IP limiting (Cloudflare sits in front at the edge). Per-instance by
 * nature — use PgTokenBucketLimiter where the limit must hold across
 * instances.
 */
export class TokenBucketLimiter implements RateLimiter {
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

/**
 * Durable token bucket in Postgres (rate_limit_buckets): one atomic upsert
 * per check, correct under concurrency across many API instances.
 *
 * Denials do not consume tokens or touch updated_at (the conditional UPDATE
 * simply matches no row), so refill accrues from the last successful take.
 * On database errors the limiter FAILS OPEN with a logged warning: these
 * buckets protect expensive routes from abuse, and refusing all checkouts
 * during a database blip would be the worse failure.
 */
export class PgTokenBucketLimiter implements RateLimiter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly log: Logger,
  ) {}

  async allow(key: string): Promise<boolean> {
    try {
      const res = await this.pool.query(
        `insert into rate_limit_buckets as b (key, tokens, updated_at)
         values ($1, $2::numeric - 1, now())
         on conflict (key) do update
           set tokens = least($2::numeric,
                              b.tokens + extract(epoch from (now() - b.updated_at)) * $3::numeric) - 1,
               updated_at = now()
           where least($2::numeric,
                       b.tokens + extract(epoch from (now() - b.updated_at)) * $3::numeric) >= 1
         returning tokens`,
        [key, this.capacity, this.refillPerSecond],
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "rate limiter unavailable — failing open");
      return true;
    }
  }
}

export function rateLimit(limiter: RateLimiter, keyBy: "ip" | "user"): MiddlewareHandler {
  return async (c, next) => {
    const key =
      keyBy === "user"
        ? (c.get("user")?.userId ??
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
          "anonymous")
        : (c.req.header("cf-connecting-ip") ??
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown");
    if (!(await limiter.allow(`${keyBy}:${key}`))) {
      c.header("Retry-After", "30");
      return c.json({ error: { code: "rate_limited", message: "Too many requests" } }, 429);
    }
    await next();
  };
}
