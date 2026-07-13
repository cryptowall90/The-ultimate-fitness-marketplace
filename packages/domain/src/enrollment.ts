import type { EnrollmentStatus } from "@fitmarket/types";

/**
 * Enrollment state machine. This is the single TypeScript source of truth and
 * mirrors app.validate_enrollment_transition() in migration 0007 — the
 * database enforces the same rules as defense in depth. Keep both in sync.
 */
const TRANSITIONS: Record<EnrollmentStatus, readonly EnrollmentStatus[]> = {
  pending_payment: ["pending_acceptance", "scheduled", "active", "canceled", "expired"],
  pending_acceptance: ["scheduled", "active", "canceled", "refunded"],
  scheduled: ["active", "canceled", "refunded"],
  active: ["paused", "completed", "expired", "canceled", "refunded", "terminated"],
  paused: ["active", "completed", "expired", "canceled", "refunded", "terminated"],
  completed: ["refunded"],
  expired: ["refunded"],
  canceled: [],
  refunded: [],
  terminated: [],
};

export function canTransitionEnrollment(from: EnrollmentStatus, to: EnrollmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertEnrollmentTransition(from: EnrollmentStatus, to: EnrollmentStatus): void {
  if (!canTransitionEnrollment(from, to)) {
    throw new Error(`invalid enrollment transition ${from} -> ${to}`);
  }
}

/** Statuses that make a client "active" for CRM and messaging purposes. */
export const WORKING_STATUSES: readonly EnrollmentStatus[] = ["active", "paused"];

/** Statuses that establish a verified trainer-client relationship. */
export const RELATIONSHIP_STATUSES: readonly EnrollmentStatus[] = [
  "pending_acceptance",
  "scheduled",
  "active",
  "paused",
  "completed",
  "expired",
];

export interface AccessWindow {
  actualStartAt: Date | null;
  accessEndsAt: Date | null;
}

/** Program content access requires an in-window entitlement. */
export function hasContentAccess(
  status: EnrollmentStatus,
  window: AccessWindow,
  now: Date,
): boolean {
  if (!WORKING_STATUSES.includes(status) && status !== "completed") return false;
  if (window.actualStartAt && now < window.actualStartAt) return false;
  if (window.accessEndsAt && now >= window.accessEndsAt) return false;
  return true;
}

/** Ordinary messaging requires an active (not merely historical) enrollment. */
export function hasMessagingAccess(
  status: EnrollmentStatus,
  window: AccessWindow,
  now: Date,
): boolean {
  if (!WORKING_STATUSES.includes(status)) return false;
  if (window.accessEndsAt && now >= window.accessEndsAt) return false;
  return true;
}
