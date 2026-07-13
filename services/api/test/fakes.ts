import { randomUUID } from "node:crypto";
import type {
  CheckoutSession,
  CheckoutSessionRequest,
  ConnectGateway,
  PaymentGateway,
  SubscriptionGateway,
} from "@fitmarket/payments";

export class FakePaymentGateway implements PaymentGateway {
  sessions: CheckoutSessionRequest[] = [];
  refunds: unknown[] = [];

  async createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSession> {
    this.sessions.push(req);
    // Globally unique: orders.stripe_checkout_session_id is UNIQUE and the
    // database is shared across test files, so per-instance counters collide.
    const sessionId = `cs_fake_${randomUUID()}`;
    return {
      providerSessionId: sessionId,
      url: `https://checkout.stripe.test/session/${sessionId}`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  async createRefund(req: unknown): Promise<{ providerRefundId: string; status: string }> {
    this.refunds.push(req);
    return { providerRefundId: `re_fake_${this.refunds.length}`, status: "succeeded" };
  }
}

export class FakeSubscriptionGateway implements SubscriptionGateway {
  customers = 0;
  invoiceItems: { providerCustomerId: string; idempotencyKey: string; amountCents: number }[] = [];

  async createCustomer(): Promise<{ providerCustomerId: string }> {
    this.customers += 1;
    return { providerCustomerId: `cus_fake_${this.customers}` };
  }

  async createSubscriptionCheckout(): Promise<CheckoutSession> {
    return {
      providerSessionId: "cs_sub_fake",
      url: "https://checkout.stripe.test/sub",
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  async cancelAtPeriodEnd(): Promise<void> {}

  async createInvoiceItem(req: {
    providerCustomerId: string;
    amount: { amountCents: number; currency: string };
    description: string;
    idempotencyKey: string;
  }): Promise<{ providerInvoiceItemId: string }> {
    // Provider-side idempotency: same key returns the same item.
    const existing = this.invoiceItems.findIndex((i) => i.idempotencyKey === req.idempotencyKey);
    if (existing >= 0) return { providerInvoiceItemId: `ii_fake_${existing}` };
    this.invoiceItems.push({
      providerCustomerId: req.providerCustomerId,
      idempotencyKey: req.idempotencyKey,
      amountCents: req.amount.amountCents,
    });
    return { providerInvoiceItemId: `ii_fake_${this.invoiceItems.length - 1}` };
  }
}

export class FakeConnectGateway implements ConnectGateway {
  accounts = 0;

  async createConnectedAccount(): Promise<{ providerAccountId: string }> {
    this.accounts += 1;
    return { providerAccountId: `acct_fake${this.accounts}` };
  }

  async createOnboardingLink(): Promise<{ url: string; expiresAt: Date }> {
    return {
      url: "https://connect.stripe.test/onboarding",
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async getAccountStatus(): Promise<{
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    disabledReason: string | null;
    requirementsDue: string[];
  }> {
    return {
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      disabledReason: null,
      requirementsDue: [],
    };
  }
}
