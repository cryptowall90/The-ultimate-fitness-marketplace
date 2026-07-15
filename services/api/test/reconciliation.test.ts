import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSellableTrainer,
  createTestApp,
  createUser,
  json,
  signAccessToken,
  signStripeEvent,
  TEST_JOB_TOKEN,
  type TestApp,
  type TrainerFixture,
} from "./helpers.js";

let t: TestApp;
let client: string;
let fixture: TrainerFixture;

beforeAll(async () => {
  t = createTestApp();
  client = await createUser(t.pool, "recon-buyer");
  fixture = await createSellableTrainer(t.pool);
});

afterAll(async () => {
  await t.close();
});

async function runJob(token = TEST_JOB_TOKEN): Promise<Response> {
  return t.app.request("/v1/jobs/reconciliation", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

function yesterdayAtNoonUtc(): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** Creates a paid order through the real checkout + webhook path. */
async function createPaidOrder(eventId: string): Promise<string> {
  const token = await signAccessToken(client);
  const checkout = await t.app.request("/v1/checkout/programs", {
    method: "POST",
    body: JSON.stringify({ programId: fixture.programId }),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
  const checkoutBody = await json(checkout);
  expect(checkout.status, JSON.stringify(checkoutBody)).toBe(200);
  const { orderId } = checkoutBody;
  const event = {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    api_version: "2024-12-18.acacia",
    data: {
      object: {
        id: `cs_${eventId}`,
        object: "checkout.session",
        mode: "payment",
        payment_intent: `pi_${eventId}`,
        metadata: { order_id: orderId },
        client_reference_id: orderId,
      },
    },
  };
  const { body, signature } = signStripeEvent(t.stripe, event);
  await t.app.request("/v1/webhooks/stripe", {
    method: "POST",
    body,
    headers: { "stripe-signature": signature },
  });
  return orderId;
}

describe("reconciliation job", () => {
  it("rejects invalid job tokens", async () => {
    const res = await runJob("wrong-token-wrong-token-wrong-token-000");
    expect(res.status).toBe(401);
  });

  it("skips when a run for the same day is already in flight", async () => {
    const lockKey = `recon:${new Date().toISOString().slice(0, 10)}`;
    await t.pool.query(
      `insert into scheduled_job_runs (job_name, lock_key, status) values ('reconciliation', $1, 'running')`,
      [lockKey],
    );
    try {
      const res = await runJob();
      expect(res.status).toBe(200);
      expect((await json(res)).skipped).toBe(true);
    } finally {
      await t.pool.query(
        `update scheduled_job_runs set status = 'succeeded', finished_at = now()
         where job_name = 'reconciliation' and lock_key = $1 and status = 'running'`,
        [lockKey],
      );
    }
  });

  it("re-processes dead-letter webhook events through the real handlers", async () => {
    // A connected-account update that previously failed processing. Uses a
    // dedicated trainer: the replayed payload disables charges for the account.
    const deadLetterTrainer = await createSellableTrainer(t.pool);
    const acct = await t.pool.query(
      `select stripe_account_id from stripe_connected_accounts where trainer_id = $1`,
      [deadLetterTrainer.trainerId],
    );
    const stripeAccountId = acct.rows[0].stripe_account_id as string;
    const eventId = `evt_dead_${Date.now()}`;
    await t.pool.query(
      `insert into webhook_events (provider, event_id, event_type, api_version, payload, status, attempts, last_error, received_at)
       values ('stripe', $1, 'account.updated', '2024-12-18.acacia', $2, 'failed', 1, 'boom', now() - interval '1 hour')`,
      [
        eventId,
        JSON.stringify({
          data: {
            object: {
              id: stripeAccountId,
              details_submitted: true,
              charges_enabled: false,
              payouts_enabled: false,
              requirements: { disabled_reason: "requirements.past_due", currently_due: ["id"] },
            },
          },
        }),
      ],
    );
    // A fresh failed event (too young) must NOT be retried yet.
    const youngEventId = `evt_young_${Date.now()}`;
    await t.pool.query(
      `insert into webhook_events (provider, event_id, event_type, api_version, payload, status, attempts, received_at)
       values ('stripe', $1, 'account.updated', '2024-12-18.acacia', '{"data":{"object":{}}}', 'failed', 1, now())`,
      [youngEventId],
    );

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.skipped).toBe(false);
    expect(body.deadLettersReprocessed).toBeGreaterThanOrEqual(1);

    const reprocessed = await t.pool.query(
      `select status, attempts, last_error from webhook_events where event_id = $1`,
      [eventId],
    );
    expect(reprocessed.rows[0].status).toBe("processed");
    expect(reprocessed.rows[0].attempts).toBe(2);
    expect(reprocessed.rows[0].last_error).toBeNull();

    const young = await t.pool.query(
      `select status, attempts from webhook_events where event_id = $1`,
      [youngEventId],
    );
    expect(young.rows[0].status).toBe("failed");
    expect(young.rows[0].attempts).toBe(1);

    // The handler really ran: account flags were synced from the payload.
    const account = await t.pool.query(
      `select charges_enabled, disabled_reason from stripe_connected_accounts where stripe_account_id = $1`,
      [stripeAccountId],
    );
    expect(account.rows[0].charges_enabled).toBe(false);
    expect(account.rows[0].disabled_reason).toBe("requirements.past_due");
  });

  it("flags provider/internal mismatches above the alert threshold", async () => {
    const orderId = await createPaidOrder(`evt_recon_${Date.now()}`);
    const when = yesterdayAtNoonUtc();
    await t.pool.query(`update payments set succeeded_at = $2 where order_id = $1`, [
      orderId,
      when,
    ]);

    // Provider reports 5000 cents less than our books for that day.
    t.reconciliation.transactions = [
      {
        id: "txn_recon_1",
        type: "charge",
        amountCents: 19900 - 5000,
        feeCents: 0,
        currency: "usd",
        createdAt: when,
      },
    ];

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    const mismatch = body.mismatches.find(
      (m: { kind: string; currency: string }) => m.kind === "charges" && m.currency === "usd",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch.differenceCents).toBe(-5000);

    // Mismatches are persisted on the job run for the runbook.
    const run = await t.pool.query(
      `select metadata, status from scheduled_job_runs
       where job_name = 'reconciliation' order by started_at desc limit 1`,
    );
    expect(run.rows[0].status).toBe("succeeded");
    expect(run.rows[0].metadata.mismatches.length).toBeGreaterThanOrEqual(1);
  });

  it("stays quiet when provider and internal sums match", async () => {
    const when = yesterdayAtNoonUtc();
    const internal = await t.pool.query(
      `select coalesce(sum(amount_cents), 0)::bigint as total from payments
       where status = 'succeeded' and succeeded_at >= $1::timestamptz - interval '12 hours'
         and succeeded_at < $1::timestamptz + interval '12 hours'`,
      [when],
    );
    t.reconciliation.transactions = [
      {
        id: "txn_recon_2",
        type: "charge",
        amountCents: Number(internal.rows[0].total),
        feeCents: 0,
        currency: "usd",
        createdAt: when,
      },
    ];

    const res = await runJob();
    const body = await json(res);
    const usdChargeMismatch = body.mismatches.find(
      (m: { kind: string; currency: string }) => m.kind === "charges" && m.currency === "usd",
    );
    expect(usdChargeMismatch).toBeUndefined();
  });
});
