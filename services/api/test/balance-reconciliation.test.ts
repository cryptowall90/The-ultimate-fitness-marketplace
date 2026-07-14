import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_JOB_TOKEN,
  createSellableTrainer,
  createTestApp,
  createUser,
  signAccessToken,
  type TestApp,
  json,
} from "./helpers.js";

let t: TestApp;
let client: string;

// A fixed, unique UTC day per test run keeps sums deterministic even though
// the database is shared across test files.
const DAY = "2026-03-05";

beforeAll(async () => {
  t = createTestApp();
  client = await createUser(t.pool, "balance-buyer");
});

afterAll(async () => {
  await t.close();
});

async function runJob(body: object = { date: DAY }, token = TEST_JOB_TOKEN): Promise<Response> {
  return t.app.request("/v1/jobs/reconcile-balance", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
}

/** Seeds a succeeded payment (and optionally a refund) inside DAY. */
async function seedLedger(amountCents: number, refundCents = 0): Promise<void> {
  const fixture = await createSellableTrainer(t.pool);
  const version = await t.pool.query(
    `select id from program_versions where program_id = $1 order by version desc limit 1`,
    [fixture.programId],
  );
  const snapshot = await t.pool.query(
    `insert into program_purchase_snapshots
       (program_id, program_version_id, trainer_id, title, price_cents, currency,
        duration_value, duration_unit, pricing_type, delivery_mode)
     values ($1, $2, $3, 'Balance fixture', $4, 'usd', 8, 'week', 'one_time', 'online')
     returning id`,
    [fixture.programId, version.rows[0].id, fixture.trainerId, amountCents],
  );
  const order = await t.pool.query(
    `insert into orders
       (client_id, trainer_id, program_id, purchase_snapshot_id, status, amount_cents,
        platform_fee_cents, currency, idempotency_key)
     values ($1, $2, $3, $4, 'paid', $5, 0, 'usd', $6)
     returning id`,
    [
      client,
      fixture.trainerId,
      fixture.programId,
      snapshot.rows[0].id,
      amountCents,
      `balance-${Date.now()}-${Math.random()}`,
    ],
  );
  const payment = await t.pool.query(
    `insert into payments (order_id, status, amount_cents, currency, succeeded_at)
     values ($1, 'succeeded', $2, 'usd', $3) returning id`,
    [order.rows[0].id, amountCents, `${DAY}T10:00:00Z`],
  );
  if (refundCents > 0) {
    await t.pool.query(
      `insert into refunds
         (payment_id, order_id, amount_cents, currency, status, created_at, idempotency_key)
       values ($1, $2, $3, 'usd', 'succeeded', $4, $5)`,
      [
        payment.rows[0].id,
        order.rows[0].id,
        refundCents,
        `${DAY}T12:00:00Z`,
        `balance-refund-${Date.now()}-${Math.random()}`,
      ],
    );
  }
}

describe("balance reconciliation job", () => {
  it("rejects missing/invalid job tokens and user bearer tokens", async () => {
    const missing = await t.app.request("/v1/jobs/reconcile-balance", { method: "POST" });
    expect(missing.status).toBe(401);

    const userToken = await runJob({ date: DAY }, await signAccessToken(client));
    expect(userToken.status).toBe(401);
  });

  it("matches provider and internal sums for the day (no alert)", async () => {
    await seedLedger(19900, 5000);
    t.balance.sums = { chargesGrossCents: 19900, refundsGrossCents: 5000 };

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.internal).toEqual({ chargesGrossCents: 19900, refundsGrossCents: 5000 });
    expect(body.chargesDeltaCents).toBe(0);
    expect(body.refundsDeltaCents).toBe(0);
    expect(body.alert).toBe(false);

    // The provider was queried for exactly the requested UTC day.
    expect(t.balance.lastRange?.from.toISOString()).toBe(`${DAY}T00:00:00.000Z`);
    expect(t.balance.lastRange?.to.toISOString()).toBe("2026-03-06T00:00:00.000Z");

    const run = await t.pool.query(
      `select status, error from scheduled_job_runs
       where job_name = 'balance_reconciliation' and lock_key = $1
       order by started_at desc limit 1`,
      [DAY],
    );
    expect(run.rows[0].status).toBe("succeeded");
    expect(run.rows[0].error).toBeNull();
  });

  it("alerts when the provider disagrees beyond the threshold", async () => {
    // Provider claims an extra charge the ledger never saw (> 100¢ threshold).
    t.balance.sums = { chargesGrossCents: 19900 + 5000, refundsGrossCents: 5000 };

    const res = await runJob();
    const body = await json(res);
    expect(body.chargesDeltaCents).toBe(5000);
    expect(body.alert).toBe(true);
    expect(body.thresholdCents).toBe(100);

    const run = await t.pool.query(
      `select error from scheduled_job_runs
       where job_name = 'balance_reconciliation' and lock_key = $1
       order by started_at desc limit 1`,
      [DAY],
    );
    expect(run.rows[0].error).toBe("mismatch above threshold");
  });

  it("stays quiet for deltas at or below the threshold", async () => {
    t.balance.sums = { chargesGrossCents: 19900 + 100, refundsGrossCents: 5000 };
    const body = await json(await runJob());
    expect(body.chargesDeltaCents).toBe(100);
    expect(body.alert).toBe(false);
  });

  it("rejects malformed dates", async () => {
    const res = await runJob({ date: "not-a-date" });
    expect(res.status).toBe(400);
  });
});
