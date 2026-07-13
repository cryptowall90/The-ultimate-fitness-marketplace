import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@fitmarket/observability";
import { PgTokenBucketLimiter } from "../src/ratelimit.js";
import { API_TEST_DATABASE_URL } from "./global-setup.js";

let pool: pg.Pool;
const sink = new Writable({ write: (_c, _e, cb) => cb() });
const log = createLogger({ service: "ratelimit-test", destination: sink });

beforeAll(() => {
  pool = new pg.Pool({ connectionString: API_TEST_DATABASE_URL, max: 4 });
});

afterAll(async () => {
  await pool.end();
});

const key = (suffix: string) => `test:${suffix}:${Date.now()}`;

describe("PgTokenBucketLimiter (durable, multi-instance safe)", () => {
  it("allows up to the burst capacity, then denies", async () => {
    const limiter = new PgTokenBucketLimiter(pool, 3, 0.001, log);
    const k = key("burst");
    expect(await limiter.allow(k)).toBe(true);
    expect(await limiter.allow(k)).toBe(true);
    expect(await limiter.allow(k)).toBe(true);
    expect(await limiter.allow(k)).toBe(false); // bucket empty
    expect(await limiter.allow(k)).toBe(false); // denials don't consume

    const row = await pool.query(`select tokens from rate_limit_buckets where key = $1`, [k]);
    expect(Number(row.rows[0].tokens)).toBeLessThan(1);
  });

  it("keys are independent", async () => {
    const limiter = new PgTokenBucketLimiter(pool, 1, 0.001, log);
    const a = key("independent-a");
    const b = key("independent-b");
    expect(await limiter.allow(a)).toBe(true);
    expect(await limiter.allow(a)).toBe(false);
    expect(await limiter.allow(b)).toBe(true); // unaffected by a's exhaustion
  });

  it("refills over elapsed time from the last successful take", async () => {
    const limiter = new PgTokenBucketLimiter(pool, 2, 10, log); // 10 tokens/s
    const k = key("refill");
    expect(await limiter.allow(k)).toBe(true);
    expect(await limiter.allow(k)).toBe(true);
    expect(await limiter.allow(k)).toBe(false);
    // Backdate the bucket instead of sleeping: 1s at 10/s refills to capacity.
    await pool.query(
      `update rate_limit_buckets set updated_at = updated_at - interval '1 second' where key = $1`,
      [k],
    );
    expect(await limiter.allow(k)).toBe(true);
    expect(await limiter.allow(k)).toBe(true); // capped at capacity 2
    expect(await limiter.allow(k)).toBe(false);
  });

  it("two limiter instances share one budget (the multi-instance case)", async () => {
    const a = new PgTokenBucketLimiter(pool, 2, 0.001, log);
    const b = new PgTokenBucketLimiter(pool, 2, 0.001, log);
    const k = key("shared");
    expect(await a.allow(k)).toBe(true);
    expect(await b.allow(k)).toBe(true);
    expect(await a.allow(k)).toBe(false);
    expect(await b.allow(k)).toBe(false);
  });

  it("fails open when the database is unreachable", async () => {
    const deadPool = new pg.Pool({
      connectionString: "postgres://postgres@127.0.0.1:1/nowhere",
      connectionTimeoutMillis: 200,
    });
    const limiter = new PgTokenBucketLimiter(deadPool, 1, 1, log);
    expect(await limiter.allow(key("failopen"))).toBe(true);
    await deadPool.end();
  });
});
