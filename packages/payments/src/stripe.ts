import Stripe from "stripe";
import type {
  BalanceGateway,
  BalanceSums,
  CheckoutSession,
  CheckoutSessionRequest,
  ConnectGateway,
  PaymentGateway,
  SubscriptionGateway,
  VerifiedWebhookEvent,
  WebhookVerifier,
} from "./interfaces.js";

const API_VERSION = "2024-12-18.acacia" as const;

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: API_VERSION,
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
}

/**
 * Destination-charge Connect model: the platform is the merchant of record,
 * funds route to the trainer's connected account, and the (policy-driven,
 * default 0) application fee stays with the platform. See docs/PAYMENTS.md
 * and ADR-0004.
 */
export class StripePaymentGateway implements PaymentGateway {
  constructor(private readonly stripe: Stripe) {}

  async createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: req.orderId,
        ...(req.customerEmail ? { customer_email: req.customerEmail } : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.amount.currency,
              unit_amount: req.amount.amountCents,
              product_data: { name: req.programTitle },
            },
          },
        ],
        payment_intent_data: {
          transfer_data: { destination: req.trainerConnectedAccountId },
          ...(req.applicationFee.amountCents > 0
            ? { application_fee_amount: req.applicationFee.amountCents }
            : {}),
          metadata: { order_id: req.orderId, client_user_id: req.clientUserId },
        },
        metadata: { order_id: req.orderId },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      { idempotencyKey: req.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return {
      providerSessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000),
    };
  }

  async createRefund(req: {
    providerPaymentIntentId: string;
    amount: { amountCents: number; currency: string };
    reason?: string;
    idempotencyKey: string;
    reverseTransfer: boolean;
  }): Promise<{ providerRefundId: string; status: string }> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: req.providerPaymentIntentId,
        amount: req.amount.amountCents,
        reverse_transfer: req.reverseTransfer,
        ...(req.reason ? { metadata: { reason: req.reason.slice(0, 500) } } : {}),
      },
      { idempotencyKey: req.idempotencyKey },
    );
    return { providerRefundId: refund.id, status: refund.status ?? "pending" };
  }
}

export class StripeConnectGateway implements ConnectGateway {
  constructor(private readonly stripe: Stripe) {}

  async createConnectedAccount(req: {
    trainerUserId: string;
    email: string;
    country: string;
    idempotencyKey: string;
  }): Promise<{ providerAccountId: string }> {
    const account = await this.stripe.accounts.create(
      {
        type: "express",
        email: req.email,
        country: req.country,
        capabilities: { transfers: { requested: true } },
        metadata: { trainer_user_id: req.trainerUserId },
      },
      { idempotencyKey: req.idempotencyKey },
    );
    return { providerAccountId: account.id };
  }

  async createOnboardingLink(req: {
    providerAccountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    const link = await this.stripe.accountLinks.create({
      account: req.providerAccountId,
      refresh_url: req.refreshUrl,
      return_url: req.returnUrl,
      type: "account_onboarding",
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async getAccountStatus(providerAccountId: string): Promise<{
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    disabledReason: string | null;
    requirementsDue: string[];
  }> {
    const account = await this.stripe.accounts.retrieve(providerAccountId);
    return {
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      disabledReason: account.requirements?.disabled_reason ?? null,
      requirementsDue: account.requirements?.currently_due ?? [],
    };
  }
}

export class StripeSubscriptionGateway implements SubscriptionGateway {
  constructor(private readonly stripe: Stripe) {}

  async createCustomer(req: {
    trainerUserId: string;
    email: string;
    idempotencyKey: string;
  }): Promise<{ providerCustomerId: string }> {
    const customer = await this.stripe.customers.create(
      { email: req.email, metadata: { trainer_user_id: req.trainerUserId } },
      { idempotencyKey: req.idempotencyKey },
    );
    return { providerCustomerId: customer.id };
  }

  async createSubscriptionCheckout(req: {
    providerCustomerId: string;
    priceLookupKey: string;
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession> {
    const prices = await this.stripe.prices.list({
      lookup_keys: [req.priceLookupKey],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price) throw new Error(`No active price for lookup key ${req.priceLookupKey}`);
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: req.providerCustomerId,
        line_items: [{ price: price.id, quantity: 1 }],
        ...(req.trialDays > 0 ? { subscription_data: { trial_period_days: req.trialDays } } : {}),
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      },
      { idempotencyKey: req.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return {
      providerSessionId: session.id,
      url: session.url,
      expiresAt: new Date((session.expires_at ?? Date.now() / 1000 + 1800) * 1000),
    };
  }

  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(providerSubscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async createInvoiceItem(req: {
    providerCustomerId: string;
    amount: { amountCents: number; currency: string };
    description: string;
    idempotencyKey: string;
  }): Promise<{ providerInvoiceItemId: string }> {
    const item = await this.stripe.invoiceItems.create(
      {
        customer: req.providerCustomerId,
        amount: req.amount.amountCents,
        currency: req.amount.currency,
        description: req.description,
      },
      { idempotencyKey: req.idempotencyKey },
    );
    return { providerInvoiceItemId: item.id };
  }
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

export class StripeWebhookVerifier implements WebhookVerifier {
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
  ) {
    if (!webhookSecret || webhookSecret.length < 10) {
      throw new Error("webhook secret missing or too short");
    }
  }

  verify(rawBody: string, signatureHeader: string): VerifiedWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      this.webhookSecret,
      WEBHOOK_TOLERANCE_SECONDS,
    );
    return {
      eventId: event.id,
      type: event.type,
      apiVersion: event.api_version ?? null,
      payload: JSON.parse(rawBody),
      data: event.data.object,
    };
  }
}

/**
 * Sums Stripe balance transactions for reconciliation. Uses the provider's
 * list API with auto-pagination; only charge/payment and refund types count
 * toward the gross sums (fees, payouts, adjustments are out of scope here).
 */
export class StripeBalanceGateway implements BalanceGateway {
  constructor(private readonly stripe: Stripe) {}

  async sumBalanceTransactions(range: { from: Date; to: Date }): Promise<BalanceSums> {
    let chargesGrossCents = 0;
    let refundsGrossCents = 0;
    const created = {
      gte: Math.floor(range.from.getTime() / 1000),
      lt: Math.floor(range.to.getTime() / 1000),
    };
    for await (const txn of this.stripe.balanceTransactions.list({ created, limit: 100 })) {
      if (txn.type === "charge" || txn.type === "payment") {
        chargesGrossCents += txn.amount;
      } else if (txn.type === "refund" || txn.type === "payment_refund") {
        refundsGrossCents += -txn.amount; // refund amounts are negative
      }
    }
    return { chargesGrossCents, refundsGrossCents };
  }
}
