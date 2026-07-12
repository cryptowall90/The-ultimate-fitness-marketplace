import { describe, expect, it } from "vitest";
import {
  assertEnrollmentTransition,
  canTransitionEnrollment,
  hasContentAccess,
  hasMessagingAccess,
} from "../src/enrollment.js";
import { canTransitionOrder } from "../src/orders.js";

describe("enrollment state machine", () => {
  it("allows the happy path", () => {
    expect(canTransitionEnrollment("pending_payment", "active")).toBe(true);
    expect(canTransitionEnrollment("active", "completed")).toBe(true);
    expect(canTransitionEnrollment("paused", "active")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransitionEnrollment("canceled", "active")).toBe(false);
    expect(canTransitionEnrollment("refunded", "active")).toBe(false);
    expect(canTransitionEnrollment("expired", "active")).toBe(false);
    expect(() => assertEnrollmentTransition("terminated", "active")).toThrow(/invalid/);
  });

  it("expired enrollment blocks messaging but transition to refund still allowed", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    expect(
      hasMessagingAccess("expired", { actualStartAt: null, accessEndsAt: null }, now),
    ).toBe(false);
    expect(canTransitionEnrollment("expired", "refunded")).toBe(true);
  });
});

describe("content access", () => {
  const window = {
    actualStartAt: new Date("2026-06-01T00:00:00Z"),
    accessEndsAt: new Date("2026-07-01T00:00:00Z"),
  };

  it("grants access during the window for active enrollment", () => {
    expect(hasContentAccess("active", window, new Date("2026-06-15T00:00:00Z"))).toBe(true);
  });

  it("blocks access after entitlement expiration", () => {
    expect(hasContentAccess("active", window, new Date("2026-07-01T00:00:00Z"))).toBe(false);
    expect(hasContentAccess("expired", window, new Date("2026-07-02T00:00:00Z"))).toBe(false);
  });

  it("blocks access before the start", () => {
    expect(hasContentAccess("active", window, new Date("2026-05-31T23:59:59Z"))).toBe(false);
  });

  it("blocks access for canceled/refunded/terminated", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(hasContentAccess("canceled", window, now)).toBe(false);
    expect(hasContentAccess("refunded", window, now)).toBe(false);
    expect(hasContentAccess("terminated", window, now)).toBe(false);
  });
});

describe("messaging access after expiration", () => {
  it("disables ordinary messages once access ends", () => {
    const window = {
      actualStartAt: new Date("2026-06-01T00:00:00Z"),
      accessEndsAt: new Date("2026-07-01T00:00:00Z"),
    };
    expect(hasMessagingAccess("active", window, new Date("2026-06-30T23:59:59Z"))).toBe(true);
    expect(hasMessagingAccess("active", window, new Date("2026-07-01T00:00:00Z"))).toBe(false);
  });
});

describe("order state machine", () => {
  it("never allows paid from nothing or double-pay loops", () => {
    expect(canTransitionOrder("created", "paid")).toBe(false);
    expect(canTransitionOrder("awaiting_payment", "paid")).toBe(true);
    expect(canTransitionOrder("paid", "awaiting_payment")).toBe(false);
    expect(canTransitionOrder("refunded", "paid")).toBe(false);
  });
});
