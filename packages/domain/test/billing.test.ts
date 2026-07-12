import { describe, expect, it } from "vitest";
import {
  billingIdempotencyKey,
  computeBillableLineItems,
  isBillable,
  totalActiveClientFee,
  type BillableEnrollmentCandidate,
  type BillingPeriod,
} from "../src/billing.js";
import { money } from "../src/money.js";

const FEE = money(250, "usd");
const TRAINER = "11111111-1111-1111-1111-111111111111";

const period: BillingPeriod = {
  start: new Date("2026-07-01T00:00:00Z"),
  end: new Date("2026-08-01T00:00:00Z"),
};

function candidate(over: Partial<BillableEnrollmentCandidate>): BillableEnrollmentCandidate {
  return {
    enrollmentId: "e1",
    clientId: "c1",
    status: "active",
    actualStartAt: new Date("2026-06-15T00:00:00Z"),
    accessEndsAt: new Date("2026-09-15T00:00:00Z"),
    refundedAt: null,
    fullyRefundedBeforeAccess: false,
    ...over,
  };
}

describe("active-client billability", () => {
  it("bills an active enrollment overlapping the period", () => {
    expect(isBillable(candidate({}), period)).toBe(true);
  });

  it("bills overlap of a single day at period boundaries", () => {
    // access ends the first day of the period
    expect(
      isBillable(
        candidate({
          actualStartAt: new Date("2026-06-01T00:00:00Z"),
          accessEndsAt: new Date("2026-07-01T12:00:00Z"),
        }),
        period,
      ),
    ).toBe(true);
    // access starts the last day of the period
    expect(
      isBillable(
        candidate({
          actualStartAt: new Date("2026-07-31T23:00:00Z"),
          accessEndsAt: null,
        }),
        period,
      ),
    ).toBe(true);
  });

  it("does not bill enrollments outside the period", () => {
    expect(
      isBillable(
        candidate({
          actualStartAt: new Date("2026-05-01T00:00:00Z"),
          accessEndsAt: new Date("2026-06-30T23:59:59Z"),
        }),
        period,
      ),
    ).toBe(false);
    expect(
      isBillable(candidate({ actualStartAt: new Date("2026-08-01T00:00:00Z") }), period),
    ).toBe(false);
  });

  it("does not bill never-activated or pre-access refunded enrollments", () => {
    expect(isBillable(candidate({ actualStartAt: null }), period)).toBe(false);
    expect(isBillable(candidate({ fullyRefundedBeforeAccess: true }), period)).toBe(false);
    expect(
      isBillable(candidate({ status: "pending_payment", actualStartAt: null }), period),
    ).toBe(false);
    expect(isBillable(candidate({ status: "canceled" }), period)).toBe(false);
  });

  it("treats refund time as the end of the access window", () => {
    // refunded before the period started -> not billable
    expect(
      isBillable(
        candidate({
          status: "refunded",
          refundedAt: new Date("2026-06-20T00:00:00Z"),
        }),
        period,
      ),
    ).toBe(false);
    // refunded mid-period -> was active during the period -> billable
    expect(
      isBillable(
        candidate({
          status: "refunded",
          refundedAt: new Date("2026-07-10T00:00:00Z"),
        }),
        period,
      ),
    ).toBe(true);
  });
});

describe("computeBillableLineItems", () => {
  it("charges one enrollment exactly once per period", () => {
    const items = computeBillableLineItems(
      TRAINER,
      [candidate({}), candidate({})], // duplicate rows from a join
      period,
      FEE,
      new Set(),
    );
    expect(items).toHaveLength(1);
  });

  it("skips enrollments already billed for the period", () => {
    const items = computeBillableLineItems(TRAINER, [candidate({})], period, FEE, new Set(["e1"]));
    expect(items).toHaveLength(0);
  });

  it("produces deterministic idempotency keys", () => {
    const a = billingIdempotencyKey(TRAINER, "e1", period.start);
    const b = billingIdempotencyKey(TRAINER, "e1", new Date("2026-07-01T00:00:00Z"));
    expect(a).toBe(b);
    const augustKey = billingIdempotencyKey(TRAINER, "e1", new Date("2026-08-01T00:00:00Z"));
    expect(augustKey).not.toBe(a);
  });

  it("bills distinct clients per enrollment and totals correctly", () => {
    const items = computeBillableLineItems(
      TRAINER,
      [
        candidate({}),
        candidate({ enrollmentId: "e2", clientId: "c2" }),
        candidate({ enrollmentId: "e3", clientId: "c3", status: "canceled" }),
      ],
      period,
      FEE,
      new Set(),
    );
    expect(items).toHaveLength(2);
    expect(totalActiveClientFee(items, FEE).amountCents).toBe(500);
  });

  it("handles timezone-boundary starts (UTC persistence)", () => {
    // 2026-06-30 19:00 in America/New_York is 2026-06-30T23:00Z — still June in UTC.
    const juneStart = candidate({
      enrollmentId: "e-tz",
      actualStartAt: new Date("2026-06-30T23:00:00Z"),
      accessEndsAt: new Date("2026-06-30T23:30:00Z"),
    });
    expect(isBillable(juneStart, period)).toBe(false);
    // One hour later it is July in UTC and billable for July.
    const julyStart = candidate({
      enrollmentId: "e-tz2",
      actualStartAt: new Date("2026-07-01T00:00:00Z"),
      accessEndsAt: new Date("2026-07-01T12:00:00Z"),
    });
    expect(isBillable(julyStart, period)).toBe(true);
  });
});
