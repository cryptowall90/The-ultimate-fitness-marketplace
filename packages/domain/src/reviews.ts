import type { EnrollmentStatus } from "@fitmarket/types";

/** Review eligibility mirrors app.can_review() in migration 0009. */
export function canSubmitReview(input: {
  enrollmentStatus: EnrollmentStatus;
  reviewEntitlementActive: boolean;
  existingReviewForEnrollment: boolean;
}): boolean {
  if (input.existingReviewForEnrollment) return false;
  if (!["active", "paused"].includes(input.enrollmentStatus)) return false;
  return input.reviewEntitlementActive;
}

export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= 1 && rating <= 5;
}

/**
 * Bayesian-smoothed rating for ranking: (C*m + sum) / (C + n).
 * Prevents a single 5-star review from outranking well-reviewed trainers.
 * Mirrors app.recompute_trainer_rating (C=5, m=3.5).
 */
export const RATING_PRIOR_WEIGHT = 5;
export const RATING_PRIOR_MEAN = 3.5;

export function weightedRating(ratingSum: number, reviewCount: number): number {
  if (!Number.isInteger(ratingSum) || !Number.isInteger(reviewCount) || reviewCount < 0) {
    throw new TypeError("ratingSum and reviewCount must be non-negative integers");
  }
  return (
    Math.round(
      ((RATING_PRIOR_WEIGHT * RATING_PRIOR_MEAN + ratingSum) /
        (RATING_PRIOR_WEIGHT + reviewCount)) *
        1000,
    ) / 1000
  );
}
