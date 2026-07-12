import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import type { VerifiedWebhookEvent } from "@fitmarket/payments";
import { withTransaction } from "../db.js";

/**
 * Stripe webhook processing.
 *
 * Guarantees:
 *  - Dedupe: each (provider, event_id) is processed at most once, enforced by
 *    the webhook_events unique constraint claimed BEFORE processing.
 *  - Idempotent handlers: replaying an already-processed event is a no-op.
 *  - Out-of-order tolerance: handlers check current state, not assumed state.
 *  - Failures are recorded and retried by Stripe; after repeated failures the
 *    row stays in 'failed' for the dead-letter reconciliation job.
 */
export async function processStripeEvent(
  pool: pg.Pool,
  log: Logger,
  event: VerifiedWebhookEvent,
): Promise<{ outcome: "processed" | "duplicate" | "ignored" }> {
  const claim = await pool.query(
    `insert into webhook_events (provider, event_id, event_type, api_version, payload, status)
     values ('stripe', $1, $2, $3, $4, 'processing')
     on conflict (provider, event_id) do nothing
     returning id`,
    [event.eventId, event.type, event.apiVersion, JSON.stringify(event.payload)],
  );
  if (claim.rowCount === 0) {
    log.info({ eventId: event.eventId, eventType: event.type }, "duplicate webhook ignored");
    return { outcome: "duplicate" };
  }
  const webhookRowId: string = claim.rows[0].id;

  try {
    let handled = true;
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(pool, log, event.data as CheckoutSessionData);
        break;
      case "charge.refunded":
        await handleChargeRefunded(pool, event.data as ChargeData);
        break;
      case "charge.dispute.created":
        await handleDisputeCreated(pool, event.data as DisputeData);
        break;
      case "account.updated":
        await handleAccountUpdated(pool, event.data as AccountData);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionChanged(pool, event.data as SubscriptionData);
        break;
      case "invoice.paid":
      case "invoice.payment_failed":
        await handleInvoiceEvent(pool, event.type, event.data as InvoiceData);
        break;
      default:
        handled = false;
    }
    await pool.query(
      `update webhook_events set status = 'processed', processed_at = now(), attempts = attempts + 1
       where id = $1`,
      [webhookRowId],
    );
    return { outcome: handled ? "processed" : "ignored" };
  } catch (err) {
    await pool.query(
      `update webhook_events set status = 'failed', attempts = attempts + 1, last_error = $2
       where id = $1`,
      [webhookRowId, (err as Error).message.slice(0, 1000)],
    );
    throw err;
  }
}

interface CheckoutSessionData {
  id: string;
  mode?: string;
  payment_intent?: string | null;
  metadata?: { order_id?: string };
  client_reference_id?: string | null;
  customer?: string | null;
  subscription?: string | null;
}

interface ChargeData {
  id: string;
  payment_intent?: string | null;
  amount_refunded?: number;
  currency?: string;
  refunds?: { data?: { id: string; amount: number; status: string }[] };
}

interface DisputeData {
  id: string;
  charge?: string;
  payment_intent?: string | null;
  amount?: number;
  currency?: string;
  reason?: string;
  status?: string;
  evidence_details?: { due_by?: number };
}

interface AccountData {
  id: string;
  details_submitted?: boolean;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  requirements?: { disabled_reason?: string | null; currently_due?: string[] };
}

interface SubscriptionData {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
}

interface InvoiceData {
  id: string;
  customer: string;
  subscription?: string | null;
  period_start?: number;
  period_end?: number;
  amount_due?: number;
  currency?: string;
}

/** Payment success → order paid → enrollment + entitlements + conversation. */
async function handleCheckoutCompleted(
  pool: pg.Pool,
  log: Logger,
  session: CheckoutSessionData,
): Promise<void> {
  if (session.mode === "subscription") return; // trainer subscription checkouts handled via subscription events
  const orderId = session.metadata?.order_id ?? session.client_reference_id;
  if (!orderId) throw new Error(`checkout session ${session.id} has no order reference`);

  await withTransaction(pool, async (tx) => {
    const orderRes = await tx.query(`select * from orders where id = $1 for update`, [orderId]);
    const order = orderRes.rows[0];
    if (!order) throw new Error(`order ${orderId} not found for checkout session ${session.id}`);
    if (order.status === "paid") return; // idempotent replay

    await tx.query(
      `update orders set status = 'paid', paid_at = now(), stripe_payment_intent_id = $2
       where id = $1`,
      [orderId, session.payment_intent ?? null],
    );
    await tx.query(
      `insert into payments (order_id, stripe_payment_intent_id, status, amount_cents, currency, succeeded_at)
       values ($1, $2, 'succeeded', $3, $4, now())
       on conflict (stripe_payment_intent_id) do nothing`,
      [
        orderId,
        session.payment_intent ?? `session:${session.id}`,
        order.amount_cents,
        order.currency,
      ],
    );

    // Enrollment + access window from the immutable purchase snapshot.
    const snapshotRes = await tx.query(`select * from program_purchase_snapshots where id = $1`, [
      order.purchase_snapshot_id,
    ]);
    const snapshot = snapshotRes.rows[0];
    const intervalSql =
      snapshot.duration_unit === "day"
        ? `${snapshot.duration_value} days`
        : snapshot.duration_unit === "week"
          ? `${snapshot.duration_value * 7} days`
          : `${snapshot.duration_value} months`;

    const existing = await tx.query(`select id from enrollments where order_id = $1`, [orderId]);
    if (existing.rowCount && existing.rowCount > 0) return; // duplicate-safety net

    const enrollmentRes = await tx.query(
      `insert into enrollments
         (client_id, trainer_id, program_id, purchase_snapshot_id, order_id, status,
          actual_start_at, access_ends_at)
       values ($1,$2,$3,$4,$5,'pending_payment', now(), now() + $6::interval)
       returning id, access_ends_at`,
      [
        order.client_id,
        order.trainer_id,
        order.program_id,
        order.purchase_snapshot_id,
        orderId,
        intervalSql,
      ],
    );
    const enrollmentId: string = enrollmentRes.rows[0].id;
    await tx.query(`update enrollments set status = 'active' where id = $1`, [enrollmentId]);

    for (const type of ["program_content", "messaging", "review"]) {
      await tx.query(
        `insert into entitlements (enrollment_id, client_id, trainer_id, type, status, ends_at)
         values ($1,$2,$3,$4,'active',$5)
         on conflict (enrollment_id, type) do nothing`,
        [
          enrollmentId,
          order.client_id,
          order.trainer_id,
          type,
          enrollmentRes.rows[0].access_ends_at,
        ],
      );
    }

    const convRes = await tx.query(
      `insert into conversations (enrollment_id, kind, client_id, trainer_id, status)
       values ($1,'enrollment',$2,$3,'active')
       on conflict (enrollment_id) do nothing
       returning id`,
      [enrollmentId, order.client_id, order.trainer_id],
    );
    if (convRes.rowCount && convRes.rowCount > 0) {
      const conversationId: string = convRes.rows[0].id;
      await tx.query(
        `insert into conversation_participants (conversation_id, user_id, role)
         values ($1,$2,'client'), ($1,$3,'trainer') on conflict do nothing`,
        [conversationId, order.client_id, order.trainer_id],
      );
    }

    // CRM record for the trainer.
    await tx.query(
      `insert into crm_client_records (trainer_id, client_id, stage, last_activity_at)
       values ($1,$2,'active_client',now())
       on conflict (trainer_id, client_id) do update set stage = 'active_client', last_activity_at = now()`,
      [order.trainer_id, order.client_id],
    );

    // Internal double-entry ledger (idempotency key ties to the order).
    const groupId = randomUUID();
    const entries: [string, string, number][] = [
      ["client_payment", "debit", order.amount_cents],
      ["trainer_receivable", "credit", order.amount_cents - order.platform_fee_cents],
    ];
    if (order.platform_fee_cents > 0) {
      entries.push(["platform_revenue", "credit", order.platform_fee_cents]);
    }
    for (const [account, direction, cents] of entries) {
      await tx.query(
        `insert into payment_ledger
           (entry_group_id, account, direction, amount_cents, currency, order_id,
            trainer_id, client_id, description, stripe_object_id, idempotency_key, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'webhook')
         on conflict (idempotency_key, account, direction) do nothing`,
        [
          groupId,
          account,
          direction,
          cents,
          order.currency,
          orderId,
          order.trainer_id,
          order.client_id,
          `Program purchase ${snapshot.title}`,
          session.payment_intent ?? session.id,
          `order-paid:${orderId}`,
        ],
      );
    }
    log.info({ orderId, enrollmentId }, "checkout completed: enrollment activated");
  });
}

async function handleChargeRefunded(pool: pg.Pool, charge: ChargeData): Promise<void> {
  if (!charge.payment_intent) return;
  await withTransaction(pool, async (tx) => {
    const paymentRes = await tx.query(
      `select p.*, o.id as order_id, o.status as order_status, o.client_id, o.trainer_id
       from payments p join orders o on o.id = p.order_id
       where p.stripe_payment_intent_id = $1 for update of p`,
      [charge.payment_intent],
    );
    const payment = paymentRes.rows[0];
    if (!payment) return; // not ours / not yet recorded — reconciliation catches it
    const refunded = charge.amount_refunded ?? 0;
    if (refunded <= payment.amount_refunded_cents) return; // replay / out-of-order

    const full = refunded >= payment.amount_cents;
    await tx.query(
      `update payments set amount_refunded_cents = $2,
              status = $3 where id = $1`,
      [payment.id, refunded, full ? "refunded" : "partially_refunded"],
    );
    if (payment.order_status === "paid" || payment.order_status === "partially_refunded") {
      await tx.query(`update orders set status = $2 where id = $1`, [
        payment.order_id,
        full ? "refunded" : "partially_refunded",
      ]);
    }
    for (const r of charge.refunds?.data ?? []) {
      await tx.query(
        `insert into refunds (payment_id, order_id, stripe_refund_id, amount_cents, currency, status, idempotency_key)
         values ($1,$2,$3,$4,$5,'succeeded',$6)
         on conflict (stripe_refund_id) do nothing`,
        [
          payment.id,
          payment.order_id,
          r.id,
          r.amount,
          charge.currency ?? payment.currency,
          `refund:${r.id}`,
        ],
      );
    }
    if (full) {
      // Revoke access; enrollment transition validated by the DB state machine.
      const en = await tx.query(`select id, status from enrollments where order_id = $1`, [
        payment.order_id,
      ]);
      const enrollment = en.rows[0];
      if (
        enrollment &&
        ["pending_acceptance", "scheduled", "active", "paused", "completed", "expired"].includes(
          enrollment.status,
        )
      ) {
        await tx.query(`update enrollments set status = 'refunded' where id = $1`, [enrollment.id]);
        await tx.query(
          `update entitlements set status = 'revoked', revoked_at = now(), revoke_reason = 'refund'
           where enrollment_id = $1 and status = 'active'`,
          [enrollment.id],
        );
      }
      const delta = refunded - payment.amount_refunded_cents;
      await tx.query(
        `insert into payment_ledger
           (entry_group_id, account, direction, amount_cents, currency, order_id, refund_id,
            trainer_id, client_id, description, stripe_object_id, idempotency_key, created_by)
         values ($1,'refunds','debit',$2,$3,$4,null,$5,$6,'Refund issued',$7,$8,'webhook')
         on conflict (idempotency_key, account, direction) do nothing`,
        [
          randomUUID(),
          delta > 0 ? delta : refunded,
          payment.currency,
          payment.order_id,
          payment.trainer_id,
          payment.client_id,
          charge.id,
          `charge-refunded:${charge.id}:${refunded}`,
        ],
      );
    }
  });
}

async function handleDisputeCreated(pool: pg.Pool, dispute: DisputeData): Promise<void> {
  if (!dispute.payment_intent) return;
  await pool.query(
    `insert into disputes (payment_id, order_id, stripe_dispute_id, amount_cents, currency, status, reason, evidence_due_by)
     select p.id, p.order_id, $2, $3, $4, $5, $6, $7
     from payments p where p.stripe_payment_intent_id = $1
     on conflict (stripe_dispute_id) do update set status = excluded.status`,
    [
      dispute.payment_intent,
      dispute.id,
      dispute.amount ?? 0,
      dispute.currency ?? "usd",
      mapDisputeStatus(dispute.status),
      dispute.reason ?? null,
      dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null,
    ],
  );
}

function mapDisputeStatus(status: string | undefined): string {
  const allowed = [
    "warning_needs_response",
    "needs_response",
    "under_review",
    "won",
    "lost",
    "closed",
  ];
  return allowed.includes(status ?? "") ? (status as string) : "needs_response";
}

async function handleAccountUpdated(pool: pg.Pool, account: AccountData): Promise<void> {
  await pool.query(
    `update stripe_connected_accounts
     set details_submitted = $2, charges_enabled = $3, payouts_enabled = $4,
         disabled_reason = $5, requirements_due = $6, last_synced_at = now()
     where stripe_account_id = $1`,
    [
      account.id,
      account.details_submitted ?? false,
      account.charges_enabled ?? false,
      account.payouts_enabled ?? false,
      account.requirements?.disabled_reason ?? null,
      JSON.stringify(account.requirements?.currently_due ?? []),
    ],
  );
}

function mapSubscriptionStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "suspended";
    case "canceled":
      return "canceled";
    case "incomplete":
    case "incomplete_expired":
      return "incomplete";
    default:
      return "incomplete";
  }
}

async function handleSubscriptionChanged(pool: pg.Pool, sub: SubscriptionData): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const res = await tx.query(
      `update trainer_subscription_accounts
       set stripe_subscription_id = $2, status = $3, cancel_at_period_end = $4,
           suspended_at = case when $3 = 'suspended' then now() else suspended_at end
       where stripe_customer_id = $1
       returning trainer_id`,
      [sub.customer, sub.id, mapSubscriptionStatus(sub.status), sub.cancel_at_period_end ?? false],
    );
    const trainerId = res.rows[0]?.trainer_id;
    if (!trainerId) return;
    if (sub.current_period_start && sub.current_period_end) {
      await tx.query(
        `insert into trainer_subscription_periods
           (trainer_id, period_start, period_end, base_amount_cents, currency, status)
         select $1, to_timestamp($2), to_timestamp($3),
                coalesce((select platform_subscription_cents from trainer_billing_policy
                          where effective_at <= now() order by effective_at desc limit 1), 0),
                'usd', 'open'
         on conflict (trainer_id, period_start) do nothing`,
        [trainerId, sub.current_period_start, sub.current_period_end],
      );
    }
    // Suspension pauses the public profile (billing rule).
    if (mapSubscriptionStatus(sub.status) === "suspended") {
      await tx.query(`update trainer_profiles set is_public = false where user_id = $1`, [
        trainerId,
      ]);
    }
  });
}

async function handleInvoiceEvent(
  pool: pg.Pool,
  type: "invoice.paid" | "invoice.payment_failed",
  invoice: InvoiceData,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const account = await tx.query(
      `select trainer_id from trainer_subscription_accounts where stripe_customer_id = $1`,
      [invoice.customer],
    );
    const trainerId = account.rows[0]?.trainer_id;
    if (!trainerId) return;

    if (type === "invoice.paid") {
      await tx.query(
        `update trainer_subscription_accounts
         set status = 'active', delinquent_since = null, grace_period_ends_at = null
         where trainer_id = $1 and status in ('past_due','grace_period','incomplete','active','trialing')`,
        [trainerId],
      );
      await tx.query(
        `update active_client_billing_ledger set status = 'finalized', finalized_at = now(),
                stripe_invoice_id = $2
         where trainer_id = $1 and status = 'invoiced' and stripe_invoice_id is null`,
        [trainerId, invoice.id],
      );
      if (invoice.period_start) {
        await tx.query(
          `update trainer_subscription_periods set status = 'paid', stripe_invoice_id = $3
           where trainer_id = $1 and period_start = to_timestamp($2)`,
          [trainerId, invoice.period_start, invoice.id],
        );
      }
    } else {
      // Failed payment: past_due, start grace period from policy (dunning is
      // driven by Stripe Billing retries + these status changes).
      await tx.query(
        `update trainer_subscription_accounts
         set status = 'grace_period',
             delinquent_since = coalesce(delinquent_since, now()),
             grace_period_ends_at = now() + make_interval(days =>
               coalesce((select grace_period_days from trainer_billing_policy
                         where effective_at <= now() order by effective_at desc limit 1), 7))
         where trainer_id = $1`,
        [trainerId],
      );
    }
  });
}
