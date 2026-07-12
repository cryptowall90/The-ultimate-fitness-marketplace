import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripeWebhookVerifier, createStripeClient } from "../src/stripe.js";

// Signature verification is exercised for real: we sign payloads with
// stripe's own test-header generator and verify offline (no network).
const SECRET = "whsec_test_secret_for_unit_tests_only";
const stripe = createStripeClient("sk_test_dummy_key_never_used_for_network");
const verifier = new StripeWebhookVerifier(stripe, SECRET);

function signedPayload(payload: object): { body: string; header: string } {
  const body = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return { body, header };
}

const sampleEvent = {
  id: "evt_test_123",
  object: "event",
  type: "checkout.session.completed",
  api_version: "2024-12-18.acacia",
  data: { object: { id: "cs_test_1", object: "checkout.session", metadata: { order_id: "o1" } } },
};

describe("StripeWebhookVerifier", () => {
  it("verifies a correctly signed event", () => {
    const { body, header } = signedPayload(sampleEvent);
    const event = verifier.verify(body, header);
    expect(event.eventId).toBe("evt_test_123");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a tampered body (webhook forgery)", () => {
    const { header } = signedPayload(sampleEvent);
    const tampered = JSON.stringify({ ...sampleEvent, type: "payment_intent.succeeded" });
    expect(() => verifier.verify(tampered, header)).toThrow();
  });

  it("rejects a wrong secret", () => {
    const other = new StripeWebhookVerifier(stripe, "whsec_a_completely_different_secret");
    const { body, header } = signedPayload(sampleEvent);
    expect(() => other.verify(body, header)).toThrow();
  });

  it("rejects stale timestamps (replay protection)", () => {
    const body = JSON.stringify(sampleEvent);
    const header = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600, // 1h old > 300s tolerance
    });
    expect(() => verifier.verify(body, header)).toThrow();
  });

  it("rejects a missing or malformed signature header", () => {
    const { body } = signedPayload(sampleEvent);
    expect(() => verifier.verify(body, "")).toThrow();
    expect(() => verifier.verify(body, "t=1,v1=deadbeef")).toThrow();
  });

  it("refuses to construct with a missing webhook secret", () => {
    expect(() => new StripeWebhookVerifier(stripe, "")).toThrow(/secret/);
  });
});
