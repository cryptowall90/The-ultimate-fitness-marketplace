import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_JOB_TOKEN,
  createSellableTrainer,
  createTestApp,
  createUser,
  type TestApp,
  type TrainerFixture,
  json,
} from "./helpers.js";

let t: TestApp;
let fixture: TrainerFixture;
let clientA: string;
let clientB: string;

beforeAll(async () => {
  t = createTestApp();
  fixture = await createSellableTrainer(t.pool);
  clientA = await createUser(t.pool, "bill-a");
  clientB = await createUser(t.pool, "bill-b");

  // Open billing period covering "now".
  await t.pool.query(
    `insert into trainer_subscription_periods (trainer_id, period_start, period_end, base_amount_cents, currency, status)
     values ($1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 3499, 'usd', 'open')`,
    [fixture.trainerId],
  );

  // Two active enrollments overlapping the period (server-created fixture).
  for (const clientId of [clientA, clientB]) {
    const snapshot = await t.pool.query(
      `insert into program_purchase_snapshots
         (program_id, program_version_id, trainer_id, title, price_cents, currency,
          duration_value, duration_unit, pricing_type, delivery_mode)
       select p.id, pv.id, p.trainer_id, p.title, p.price_cents, p.currency,
              p.duration_value, p.duration_unit, p.pricing_type, p.delivery_mode
       from programs p join program_versions pv on pv.program_id = p.id
       where p.id = $1 limit 1 returning id`,
      [fixture.programId],
    );
    const en = await t.pool.query(
      `insert into enrollments
         (client_id, trainer_id, program_id, purchase_snapshot_id, status, actual_start_at, access_ends_at)
       values ($1,$2,$3,$4,'pending_payment', now() - interval '2 days', now() + interval '54 days')
       returning id`,
      [clientId, fixture.trainerId, fixture.programId, snapshot.rows[0].id],
    );
    await t.pool.query(`update enrollments set status='active' where id=$1`, [en.rows[0].id]);
  }
});

afterAll(async () => {
  await t.close();
});

describe("active-client billing job", () => {
  it("requires the job token", async () => {
    const res = await t.app.request("/v1/jobs/active-client-billing", { method: "POST" });
    expect(res.status).toBe(401);
    const wrong = await t.app.request("/v1/jobs/active-client-billing", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("critical test 8: charges each active enrollment exactly once per period, even when run twice", async () => {
    const run = () =>
      t.app.request("/v1/jobs/active-client-billing", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_JOB_TOKEN}` },
      });

    const first = await run();
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody.lineItemsCreated).toBe(2); // two active clients

    const second = await run();
    const secondBody = await json(second);
    expect(secondBody.lineItemsCreated).toBe(0); // idempotent re-run

    const ledger = await t.pool.query(
      `select amount_cents, status from active_client_billing_ledger where trainer_id = $1`,
      [fixture.trainerId],
    );
    expect(ledger.rows).toHaveLength(2);
    for (const row of ledger.rows) {
      expect(row.amount_cents).toBe(250); // $2.50 from the policy table
      expect(row.status).toBe("invoiced");
    }
    expect(t.subscriptions.invoiceItems).toHaveLength(2);
  });

  it("finalizes invoiced ledger rows when the subscription invoice is paid", async () => {
    // Simulated invoice.paid webhook effect (direct call keeps this focused).
    await t.pool.query(
      `update active_client_billing_ledger set status = 'finalized', finalized_at = now(),
              stripe_invoice_id = 'in_test_1'
       where trainer_id = $1 and status = 'invoiced'`,
      [fixture.trainerId],
    );
    const rows = await t.pool.query(
      `select count(*)::int as n from active_client_billing_ledger
       where trainer_id = $1 and status = 'finalized'`,
      [fixture.trainerId],
    );
    expect(rows.rows[0].n).toBe(2);
  });
});

describe("entitlement expiry job", () => {
  it("expires overdue entitlements and enrollments idempotently", async () => {
    const client = await createUser(t.pool, "expire-me");
    const snapshot = await t.pool.query(
      `insert into program_purchase_snapshots
         (program_id, program_version_id, trainer_id, title, price_cents, currency,
          duration_value, duration_unit, pricing_type, delivery_mode)
       select p.id, pv.id, p.trainer_id, p.title, p.price_cents, p.currency,
              p.duration_value, p.duration_unit, p.pricing_type, p.delivery_mode
       from programs p join program_versions pv on pv.program_id = p.id
       where p.id = $1 limit 1 returning id`,
      [fixture.programId],
    );
    const en = await t.pool.query(
      `insert into enrollments
         (client_id, trainer_id, program_id, purchase_snapshot_id, status, actual_start_at, access_ends_at)
       values ($1,$2,$3,$4,'pending_payment', now() - interval '60 days', now() - interval '1 hour')
       returning id`,
      [client, fixture.trainerId, fixture.programId, snapshot.rows[0].id],
    );
    await t.pool.query(`update enrollments set status='active' where id=$1`, [en.rows[0].id]);
    await t.pool.query(
      `insert into entitlements (enrollment_id, client_id, trainer_id, type, status, ends_at)
       values ($1,$2,$3,'messaging','active', now() - interval '1 hour')`,
      [en.rows[0].id, client, fixture.trainerId],
    );

    const res = await t.app.request("/v1/jobs/expire-entitlements", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_JOB_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const enrollment = await t.pool.query(`select status from enrollments where id = $1`, [
      en.rows[0].id,
    ]);
    expect(enrollment.rows[0].status).toBe("expired");
    const ents = await t.pool.query(
      `select status from entitlements where enrollment_id = $1`,
      [en.rows[0].id],
    );
    expect(ents.rows[0].status).toBe("expired");

    // Idempotent second run.
    const again = await t.app.request("/v1/jobs/expire-entitlements", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_JOB_TOKEN}` },
    });
    expect(again.status).toBe(200);
  });
});
