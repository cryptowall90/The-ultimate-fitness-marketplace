import type { Money } from "@fitmarket/types";

/**
 * Provider-agnostic payment interfaces. services/api depends on these, not on
 * Stripe directly, so an additional provider (or a fake for tests) can be
 * plugged in without touching call sites.
 */

export interface CheckoutSessionRequest {
  orderId: string;
  clientUserId: string;
  trainerConnectedAccountId: string;
  amount: Money;
  /** platform transaction commission in minor units; 0 unless enabled by policy */
  applicationFee: Money;
  programTitle: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  customerEmail?: string;
}

export interface CheckoutSession {
  providerSessionId: string;
  url: string;
  expiresAt: Date;
}

export interface PaymentGateway {
  createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSession>;
  createRefund(req: {
    providerPaymentIntentId: string;
    amount: Money;
    reason?: string;
    idempotencyKey: string;
    reverseTransfer: boolean;
  }): Promise<{ providerRefundId: string; status: string }>;
}

export interface ConnectGateway {
  createConnectedAccount(req: {
    trainerUserId: string;
    email: string;
    country: string;
    idempotencyKey: string;
  }): Promise<{ providerAccountId: string }>;
  createOnboardingLink(req: {
    providerAccountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  getAccountStatus(providerAccountId: string): Promise<{
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    disabledReason: string | null;
    requirementsDue: string[];
  }>;
}

export interface SubscriptionGateway {
  createCustomer(req: {
    trainerUserId: string;
    email: string;
    idempotencyKey: string;
  }): Promise<{ providerCustomerId: string }>;
  createSubscriptionCheckout(req: {
    providerCustomerId: string;
    priceLookupKey: string;
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession>;
  cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void>;
  /** Adds a metered active-client fee line to the customer's next invoice. */
  createInvoiceItem(req: {
    providerCustomerId: string;
    amount: Money;
    description: string;
    idempotencyKey: string;
  }): Promise<{ providerInvoiceItemId: string }>;
}

/** Daily provider-side money movement, for ledger reconciliation. */
export interface BalanceSums {
  /** Gross successful charge volume in the window, minor units. */
  chargesGrossCents: number;
  /** Gross refund volume in the window, minor units (positive number). */
  refundsGrossCents: number;
}

export interface BalanceGateway {
  /** Sums the provider's balance transactions within [from, to). */
  sumBalanceTransactions(range: { from: Date; to: Date }): Promise<BalanceSums>;
}

export interface VerifiedWebhookEvent {
  eventId: string;
  type: string;
  apiVersion: string | null;
  /** raw provider payload (persisted for audit/replay) */
  payload: unknown;
  data: unknown;
}

export interface WebhookVerifier {
  /**
   * Verifies the provider signature (with timestamp tolerance) and parses the
   * event. MUST throw on any verification failure.
   */
  verify(rawBody: string, signatureHeader: string): VerifiedWebhookEvent;
}
