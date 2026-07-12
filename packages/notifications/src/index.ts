/**
 * Notification provider interfaces. Concrete adapters (Resend/Postmark for
 * email, Expo for push, PostHog for analytics) live behind these so providers
 * can be swapped and tests can use fakes. No adapter may receive message
 * bodies from private conversations — notifications carry counts and titles,
 * not content.
 */

export type NotificationCategory =
  | "messages"
  | "check_ins"
  | "tasks"
  | "billing"
  | "marketing"
  | "reviews"
  | "enrollment";

export interface EmailMessage {
  to: string;
  templateId:
    | "verify_email"
    | "password_reset"
    | "receipt"
    | "enrollment_activated"
    | "new_message_digest"
    | "check_in_due"
    | "billing_failed"
    | "trainer_approved"
    | "payout_paid"
    | "account_deletion";
  /** Template variables. Never include secrets or private message content. */
  variables: Record<string, string | number>;
  idempotencyKey: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export interface PushMessage {
  expoPushTokens: string[];
  title: string;
  body: string;
  category: NotificationCategory;
  /** deep link path inside the app, e.g. /messages/<conversationId> */
  linkPath?: string;
  idempotencyKey: string;
}

export interface PushProvider {
  send(message: PushMessage): Promise<{ delivered: number; invalidTokens: string[] }>;
}

export interface AnalyticsEvent {
  /** anonymized/distinct id — NEVER a raw email address */
  distinctId: string;
  event: string;
  /** privacy-conscious defaults: no PII, no fitness data, no free text */
  properties?: Record<string, string | number | boolean>;
}

export interface AnalyticsProvider {
  capture(event: AnalyticsEvent): Promise<void>;
}

export class NoopAnalyticsProvider implements AnalyticsProvider {
  async capture(): Promise<void> {}
}
