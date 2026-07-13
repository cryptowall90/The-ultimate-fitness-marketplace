import type { EnrollmentStatus, Money } from "@fitmarket/types";
import { multiplyMoney } from "./money.js";

/**
 * Active-client billing (the $2.50/active-client/billing-cycle charge).
 *
 * An enrollment is billable for a trainer billing period when:
 *  1. it was accepted or paid (i.e. it reached a relationship status),
 *  2. its access period overlaps >= 1 calendar day of the billing period,
 *  3. it was not fully refunded before access began,
 *  4. it has not already been billed for that period (DB unique constraint +
 *     the dedupe here for job-level idempotency).
 *
 * Counts are ALWAYS computed server-side from the database. Nothing here
 * trusts client input.
 */

export interface BillingPeriod {
  start: Date; // inclusive
  end: Date; // exclusive
}

export interface BillableEnrollmentCandidate {
  enrollmentId: string;
  clientId: string;
  status: EnrollmentStatus;
  /** access window; null start means never activated */
  actualStartAt: Date | null;
  accessEndsAt: Date | null;
  refundedAt: Date | null;
  /** true when a full refund occurred before access began */
  fullyRefundedBeforeAccess: boolean;
}

const ACCEPTED_STATUSES: readonly EnrollmentStatus[] = [
  "active",
  "paused",
  "completed",
  "expired",
  "terminated",
  "refunded",
];

export function overlapsPeriod(
  start: Date | null,
  end: Date | null,
  period: BillingPeriod,
): boolean {
  if (!start) return false;
  const effectiveEnd = end ?? new Date(8640000000000000); // open-ended
  return start < period.end && effectiveEnd > period.start;
}

export function isBillable(c: BillableEnrollmentCandidate, period: BillingPeriod): boolean {
  if (!ACCEPTED_STATUSES.includes(c.status)) return false;
  if (c.fullyRefundedBeforeAccess) return false;
  // If refunded, the access window closed at the refund time.
  const accessEnd =
    c.refundedAt && (!c.accessEndsAt || c.refundedAt < c.accessEndsAt)
      ? c.refundedAt
      : c.accessEndsAt;
  return overlapsPeriod(c.actualStartAt, accessEnd, period);
}

export interface BillingLineItem {
  enrollmentId: string;
  clientId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

/**
 * Deterministic idempotency key: same enrollment + same period start always
 * produces the same key, so retried jobs cannot double-bill even before the
 * DB unique constraint fires.
 */
export function billingIdempotencyKey(
  trainerId: string,
  enrollmentId: string,
  periodStart: Date,
): string {
  return `acb:${trainerId}:${enrollmentId}:${periodStart.toISOString()}`;
}

export function computeBillableLineItems(
  trainerId: string,
  candidates: readonly BillableEnrollmentCandidate[],
  period: BillingPeriod,
  feePerClient: Money,
  alreadyBilledEnrollmentIds: ReadonlySet<string>,
): BillingLineItem[] {
  const seen = new Set<string>();
  const items: BillingLineItem[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.enrollmentId)) continue; // one charge per enrollment
    seen.add(candidate.enrollmentId);
    if (alreadyBilledEnrollmentIds.has(candidate.enrollmentId)) continue;
    if (!isBillable(candidate, period)) continue;
    items.push({
      enrollmentId: candidate.enrollmentId,
      clientId: candidate.clientId,
      amountCents: feePerClient.amountCents,
      currency: feePerClient.currency,
      idempotencyKey: billingIdempotencyKey(trainerId, candidate.enrollmentId, period.start),
    });
  }
  return items;
}

export function totalActiveClientFee(items: readonly BillingLineItem[], fee: Money): Money {
  return multiplyMoney(fee, items.length);
}
