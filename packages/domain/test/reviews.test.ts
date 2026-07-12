import { describe, expect, it } from "vitest";
import { canSubmitReview, isValidRating, weightedRating } from "../src/reviews.js";

describe("review eligibility", () => {
  it("requires an active enrollment with a review entitlement", () => {
    expect(
      canSubmitReview({
        enrollmentStatus: "active",
        reviewEntitlementActive: true,
        existingReviewForEnrollment: false,
      }),
    ).toBe(true);
  });

  it("blocks reviews without an eligible enrollment", () => {
    for (const status of ["pending_payment", "canceled", "expired", "refunded"] as const) {
      expect(
        canSubmitReview({
          enrollmentStatus: status,
          reviewEntitlementActive: true,
          existingReviewForEnrollment: false,
        }),
      ).toBe(false);
    }
  });

  it("blocks a second review for the same enrollment", () => {
    expect(
      canSubmitReview({
        enrollmentStatus: "active",
        reviewEntitlementActive: true,
        existingReviewForEnrollment: true,
      }),
    ).toBe(false);
  });
});

describe("rating validation", () => {
  it("accepts integers 1-5 only", () => {
    expect(isValidRating(1)).toBe(true);
    expect(isValidRating(5)).toBe(true);
    expect(isValidRating(0)).toBe(false);
    expect(isValidRating(6)).toBe(false);
    expect(isValidRating(4.5)).toBe(false);
    expect(isValidRating(Number.NaN)).toBe(false);
  });
});

describe("weighted rating", () => {
  it("keeps a single 5-star review from dominating", () => {
    const oneFive = weightedRating(5, 1);
    const manyFours = weightedRating(4 * 30, 30);
    expect(oneFive).toBeLessThan(manyFours);
    expect(oneFive).toBeCloseTo((5 * 3.5 + 5) / 6, 3);
  });

  it("approaches the raw mean as reviews accumulate", () => {
    expect(weightedRating(5 * 500, 500)).toBeGreaterThan(4.9);
  });
});
