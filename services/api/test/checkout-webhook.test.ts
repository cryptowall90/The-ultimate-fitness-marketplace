import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSellableTrainer,
  createTestApp,
  createUser,
  signAccessToken,
  signStripeEvent,
  type TestApp,
  type TrainerFixture,
  json,
} from "./helpers.js";

let t: TestApp;
let client: string;
let fixture: TrainerFixture;

beforeAll(async () => {
  t = createTestApp();
  client = await createUser(t.pool, "buyer");
  fixture = await createSellableTrainer(t.pool);
});

afterAll(async () => {
  await t.close();
});

function checkoutCompletedEvent(eventId: string, orderId: string) {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    api_version: "2024-12-18.acacia",
    data: {
      object: {
        id: `cs_evt_${eventId}`,
        object: "checkout.session",
        mode: "payment",
        payment_intent: `pi_${eventId}`,
        metadata: { order_id: orderId },
        client_reference_id: orderId,
      },
    },
  };
}

describe("checkout endpoint", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await t.app.request("/v1/checkout/programs", {
      method: "POST",
      body: JSON.stringify({ programId: fixture.programId }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects garbage tokens without leaking detail", async () => {
    const res = await t.app.request("/v1/checkout/programs", {
      method: "POST",
      body: JSON.stringify({ programId: fixture.programId }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not.a.token",
      },
    });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error.message).toBe("Invalid token");
  });

  it("rejects client-supplied price fields (strict schema)", async () => {
    const token = await signAccessToken(client);
    const res = await t.app.request("/v1/checkout/programs", {
      method: "POST",
      body: JSON.stringify({ programId: fixture.programId, priceCents: 1 }),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("creates an order and checkout session with the DATABASE price", async () => {
    const token = await signAccessToken(client);
    const res = await t.app.request("/v1/checkout/programs", {
      method: "POST",
      body: JSON.stringify({ programId: fixture.programId }),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.checkoutUrl).toContain("https://checkout.stripe.test/");

    const session = t.payments.sessions.at(-1)!;
    expect(session.amount.amountCents).toBe(19900); // from DB, not the request
    expect(session.applicationFee.amountCents).toBe(0); // commission disabled by default

    const order = await t.pool.query(`select * from orders where id = $1`, [body.orderId]);
    expect(order.rows[0].status).toBe("awaiting_payment");
    expect(order.rows[0].amount_cents).toBe(19900);

    // CRITICAL: no enrollment exists before the webhook (a frontend redirect
    // alone must never grant access).
    const enrollments = await t.pool.query(`select * from enrollments where order_id = $1`, [
      body.orderId,
    ]);
    expect(enrollments.rows).toHaveLength(0);
  });
});

describe("stripe webhook", () => {
  async function createPaidOrderViaWebhook(): Promise<{ orderId: string }> {
    const token = await signAccessToken(client);
    const res = await t.app.request("/v1/checkout/programs", {
      method: "POST",
      body: JSON.stringify({ programId: fixture.programId }),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
    const { orderId } = await json(res);
    return { orderId };
  }

  it("rejects requests without a signature", async () => {
    const res = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify({ id: "evt_x", type: "checkout.session.completed" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects forged signatures", async () => {
    const { body } = signStripeEvent(t.stripe, checkoutCompletedEvent("evt_forged", "o1"));
    const res = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": "t=123,v1=deadbeef" },
    });
    expect(res.status).toBe(400);
    const events = await t.pool.query(
      `select * from webhook_events where event_id = 'evt_forged'`,
    );
    expect(events.rows).toHaveLength(0); // unverified events are never persisted
  });

  it("activates the enrollment on verified checkout.session.completed", async () => {
    const { orderId } = await createPaidOrderViaWebhook();
    const event = checkoutCompletedEvent("evt_paid_1", orderId);
    const { body, signature } = signStripeEvent(t.stripe, event);
    const res = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });
    expect(res.status).toBe(200);

    const order = await t.pool.query(`select status from orders where id = $1`, [orderId]);
    expect(order.rows[0].status).toBe("paid");

    const enrollment = await t.pool.query(
      `select status, access_ends_at from enrollments where order_id = $1`,
      [orderId],
    );
    expect(enrollment.rows).toHaveLength(1);
    expect(enrollment.rows[0].status).toBe("active");
    expect(new Date(enrollment.rows[0].access_ends_at).getTime()).toBeGreaterThan(Date.now());

    const entitlements = await t.pool.query(
      `select e.type, e.status from entitlements e
       join enrollments en on en.id = e.enrollment_id where en.order_id = $1`,
      [orderId],
    );
    expect(entitlements.rows.map((r) => r.type).sort()).toEqual([
      "messaging",
      "program_content",
      "review",
    ]);

    const conversation = await t.pool.query(
      `select c.status from conversations c
       join enrollments en on en.id = c.enrollment_id where en.order_id = $1`,
      [orderId],
    );
    expect(conversation.rows[0].status).toBe("active");

    const ledger = await t.pool.query(
      `select account, direction, amount_cents from payment_ledger where order_id = $1`,
      [orderId],
    );
    expect(ledger.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("critical test 7: duplicate webhook delivery does not duplicate anything", async () => {
    const { orderId } = await createPaidOrderViaWebhook();
    const event = checkoutCompletedEvent("evt_dup_1", orderId);
    const { body, signature } = signStripeEvent(t.stripe, event);

    const first = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });
    expect((await json(first)).outcome).toBe("processed");

    // Exact same event id delivered again.
    const second = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });
    expect((await json(second)).outcome).toBe("duplicate");

    // Same order, DIFFERENT event id (Stripe occasionally re-emits).
    const reEmit = signStripeEvent(t.stripe, checkoutCompletedEvent("evt_dup_2", orderId));
    const third = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body: reEmit.body,
      headers: { "stripe-signature": reEmit.signature },
    });
    expect(third.status).toBe(200);

    const enrollments = await t.pool.query(
      `select count(*)::int as n from enrollments where order_id = $1`,
      [orderId],
    );
    expect(enrollments.rows[0].n).toBe(1);
    const ledger = await t.pool.query(
      `select count(*)::int as n from payment_ledger where order_id = $1 and account = 'client_payment'`,
      [orderId],
    );
    expect(ledger.rows[0].n).toBe(1);
  });

  it("handles full refunds: revokes access and records the refund", async () => {
    const { orderId } = await createPaidOrderViaWebhook();
    const paid = signStripeEvent(t.stripe, checkoutCompletedEvent("evt_refund_pay", orderId));
    await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body: paid.body,
      headers: { "stripe-signature": paid.signature },
    });

    const refundEvent = {
      id: "evt_refund_1",
      object: "event",
      type: "charge.refunded",
      api_version: "2024-12-18.acacia",
      data: {
        object: {
          id: "ch_refund_1",
          object: "charge",
          payment_intent: "pi_evt_refund_pay",
          amount_refunded: 19900,
          currency: "usd",
          refunds: { data: [{ id: "re_test_1", amount: 19900, status: "succeeded" }] },
        },
      },
    };
    const { body, signature } = signStripeEvent(t.stripe, refundEvent);
    const res = await t.app.request("/v1/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });
    expect(res.status).toBe(200);

    const order = await t.pool.query(`select status from orders where id = $1`, [orderId]);
    expect(order.rows[0].status).toBe("refunded");
    const enrollment = await t.pool.query(`select status from enrollments where order_id = $1`, [
      orderId,
    ]);
    expect(enrollment.rows[0].status).toBe("refunded");
    const entitlements = await t.pool.query(
      `select count(*)::int as n from entitlements e
       join enrollments en on en.id = e.enrollment_id
       where en.order_id = $1 and e.status = 'active'`,
      [orderId],
    );
    expect(entitlements.rows[0].n).toBe(0);
  });
});
