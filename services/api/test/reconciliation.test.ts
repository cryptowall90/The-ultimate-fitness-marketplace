import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_JOB_TOKEN,
  createSellableTrainer,
  createTestApp,
  createUser,
  signAccessToken,
  type TestApp,
  type TrainerFixture,
  json,
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

async function createAwaitingOrder(): Promise<string> {
  const token = await signAccessToken(client);
  const res = await t.app.request("/v1/checkout/programs", {
    method: "POST",
    body: JSON.stringify({ programId: fixture.programId }),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await json(res)).orderId as string;
}

function checkoutCompletedPayload(eventId: string, orderId: string): object {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
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
}

async function runJob(token = TEST_JOB_TOKEN): Promise<Response> {
  return t.app.request("/v1/jobs/reconcile-payments", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("payment reconciliation job", () => {
  it("rejects requests without the job token", async () => {
    const res = await runJob("wrong-token-wrong-token-wrong-token-wrong");
    expect(res.status).toBe(401);
  });

  it("replays a dead-lettered checkout event and grants the enrollment", async () => {
    const orderId = await createAwaitingOrder();
    // Simulate a webhook whose handler crashed after the event was claimed:
    // the row sits in 'failed' with the full payload persisted.
    await t.pool.query(
      `insert into webhook_events (provider, event_id, event_type, payload, status, attempts, last_error)
       values ('stripe', $1, 'checkout.session.completed', $2, 'failed', 1, 'db connection lost')`,
      [
        `evt_dead_${orderId}`,
        JSON.stringify(checkoutCompletedPayload(`evt_dead_${orderId}`, orderId)),
      ],
    );

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.deadLettersReplayed).toBeGreaterThanOrEqual(1);

    const order = await t.pool.query(`select status from orders where id = $1`, [orderId]);
    expect(order.rows[0].status).toBe("paid");
    const enrollment = await t.pool.query(`select status from enrollments where order_id = $1`, [
      orderId,
    ]);
    expect(enrollment.rows).toHaveLength(1);
    expect(enrollment.rows[0].status).toBe("active");

    const event = await t.pool.query(
      `select status, attempts from webhook_events where event_id = $1`,
      [`evt_dead_${orderId}`],
    );
    expect(event.rows[0].status).toBe("processed");
    expect(event.rows[0].attempts).toBe(2);
  });

  it("abandons a dead letter at the attempt cap instead of retrying forever", async () => {
    await t.pool.query(
      `insert into webhook_events (provider, event_id, event_type, payload, status, attempts, last_error)
       values ('stripe', 'evt_poison', 'checkout.session.completed', '{"no":"data"}', 'failed', 7, 'boom')`,
    );

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.deadLettersAbandoned).toBeGreaterThanOrEqual(1);

    const event = await t.pool.query(
      `select status, attempts from webhook_events where event_id = 'evt_poison'`,
    );
    expect(event.rows[0].status).toBe("failed");
    expect(event.rows[0].attempts).toBe(8);

    // At the cap the row is no longer selected: a second run leaves it alone.
    const again = await json(await runJob());
    expect(again.deadLettersAbandoned).toBe(0);
    const after = await t.pool.query(
      `select attempts from webhook_events where event_id = 'evt_poison'`,
    );
    expect(after.rows[0].attempts).toBe(8);
  });

  it("expires stale unpaid orders but leaves fresh ones alone", async () => {
    const staleId = await createAwaitingOrder();
    const freshId = await createAwaitingOrder();
    await t.pool.query(`update orders set expires_at = now() - interval '2 hours' where id = $1`, [
      staleId,
    ]);

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ordersExpired).toBeGreaterThanOrEqual(1);

    const stale = await t.pool.query(`select status from orders where id = $1`, [staleId]);
    expect(stale.rows[0].status).toBe("expired");
    const fresh = await t.pool.query(`select status from orders where id = $1`, [freshId]);
    expect(fresh.rows[0].status).toBe("awaiting_payment");
  });

  it("reports paid orders that never got an enrollment", async () => {
    // Insert a paid order directly with an old updated_at (insert bypasses
    // the touch trigger, which only fires on update).
    const versionRes = await t.pool.query(
      `select id from program_versions where program_id = $1 order by version desc limit 1`,
      [fixture.programId],
    );
    const snapshotRes = await t.pool.query(
      `insert into program_purchase_snapshots
         (program_id, program_version_id, trainer_id, title, price_cents, currency,
          duration_value, duration_unit, pricing_type, delivery_mode)
       values ($1, $2, $3, 'Orphan', 19900, 'usd', 8, 'week', 'one_time', 'online')
       returning id`,
      [fixture.programId, versionRes.rows[0].id, fixture.trainerId],
    );
    const orphan = await t.pool.query(
      `insert into orders
         (client_id, trainer_id, program_id, purchase_snapshot_id, status, amount_cents,
          platform_fee_cents, currency, idempotency_key, updated_at)
       values ($1, $2, $3, $4, 'paid', 19900, 0, 'usd', $5, now() - interval '30 minutes')
       returning id`,
      [
        client,
        fixture.trainerId,
        fixture.programId,
        snapshotRes.rows[0].id,
        `orphan-${Date.now()}`,
      ],
    );

    const res = await runJob();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.paidOrdersMissingEnrollment).toBeGreaterThanOrEqual(1);

    // The job reports; it does not invent enrollments for money it can't verify.
    const enrollment = await t.pool.query(`select 1 from enrollments where order_id = $1`, [
      orphan.rows[0].id,
    ]);
    expect(enrollment.rows).toHaveLength(0);
  });
});
