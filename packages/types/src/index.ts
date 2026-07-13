// Shared enums and DTO types. Mirror of the database enums in
// packages/database/migrations/0001_extensions_and_types.sql — keep in sync.

export type AppRole = "client" | "trainer" | "moderator" | "admin";
export type UserStatus = "active" | "suspended" | "deactivated" | "deleted";

export type TrainerApplicationStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "suspended";

export type ServiceMode = "online" | "in_person" | "hybrid";
export type CredentialStatus = "pending" | "verified" | "rejected" | "expired";
export type ProgramStatus = "draft" | "published" | "paused" | "archived";
export type PricingType = "one_time" | "recurring";
export type DurationUnit = "day" | "week" | "month";
export type EnrollmentApprovalPolicy = "automatic" | "manual";

export type OrderStatus =
  | "created"
  | "awaiting_payment"
  | "paid"
  | "canceled"
  | "expired"
  | "failed"
  | "refunded"
  | "partially_refunded";

export type PaymentStatus =
  | "requires_action"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "partially_refunded";

export type EnrollmentStatus =
  | "pending_payment"
  | "pending_acceptance"
  | "scheduled"
  | "active"
  | "paused"
  | "completed"
  | "expired"
  | "canceled"
  | "refunded"
  | "terminated";

export type EntitlementType = "program_content" | "messaging" | "review";
export type EntitlementStatus = "active" | "expired" | "revoked";
export type BillingLedgerStatus = "pending" | "invoiced" | "finalized" | "voided";

export type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "grace_period"
  | "suspended"
  | "canceled";

export type ConversationStatus = "active" | "read_only" | "archived";
export type MessageKind = "text" | "attachment" | "system" | "support";
export type ReviewModerationStatus = "pending" | "published" | "under_review" | "removed";
export type ReportStatus = "open" | "triaged" | "actioned" | "dismissed";
export type LeadStage =
  | "lead"
  | "contacted"
  | "consultation_scheduled"
  | "awaiting_payment"
  | "active_client"
  | "paused"
  | "completed"
  | "canceled"
  | "former_client";

export type MediaVisibility = "public_profile" | "private_progress" | "private_document";
export type MediaStatus =
  | "pending_upload"
  | "quarantined"
  | "processing"
  | "published"
  | "rejected"
  | "deleted";

/** Money is always integer minor units plus an ISO currency code. */
export interface Money {
  amountCents: number;
  currency: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TrainerSearchResult {
  trainerId: string;
  displayName: string;
  headline: string;
  slug: string;
  serviceMode: ServiceMode;
  averageRating: number | null;
  weightedRating: number;
  reviewCount: number;
  /** In-person search only — never exposes exact addresses. */
  serviceAreaLabel?: string;
  cityName?: string;
  distanceMeters?: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    correlationId?: string;
  };
}
