import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PaymentGateway } from "@fitmarket/payments";
import { applyBasisPoints, money } from "@fitmarket/domain";
import { withTransaction } from "../db.js";

export class CheckoutError extends Error {
  constructor(
    public readonly code:
      | "program_not_found"
      | "trainer_not_ready"
      | "self_purchase"
      | "capacity_reached",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Creates an order + Stripe Checkout Session for a published program.
 * Prices come from the published program version — NEVER from the client.
 * Access is granted later, only by the verified webhook.
 */
export async function createProgramCheckout(
  pool: pg.Pool,
  gateway: PaymentGateway,
  input: {
    programId: string;
    clientUserId: string;
    appBaseUrl: string;
  },
): Promise<{ orderId: string; checkoutUrl: string }> {
  return withTransaction(pool, async (tx) => {
    const programRes = await tx.query(
      `select p.id, p.trainer_id, p.title, p.price_cents, p.currency, p.duration_value,
              p.duration_unit, p.pricing_type, p.delivery_mode, p.capacity, p.version,
              p.cancellation_terms, p.refund_policy, p.included_features,
              sca.stripe_account_id, sca.charges_enabled,
              tsa.status as subscription_status
       from programs p
       join trainer_profiles tp on tp.user_id = p.trainer_id
         and tp.is_public and tp.application_status = 'approved'
       left join stripe_connected_accounts sca on sca.trainer_id = p.trainer_id
       left join trainer_subscription_accounts tsa on tsa.trainer_id = p.trainer_id
       where p.id = $1 and p.status = 'published'
       for update of p`,
      [input.programId],
    );
    const program = programRes.rows[0];
    if (!program) throw new CheckoutError("program_not_found", "Program not available");
    if (program.trainer_id === input.clientUserId) {
      throw new CheckoutError("self_purchase", "Trainers cannot purchase their own programs");
    }
    if (!program.stripe_account_id || !program.charges_enabled) {
      throw new CheckoutError("trainer_not_ready", "Trainer cannot accept payments yet");
    }
    if (!["trialing", "active", "grace_period"].includes(program.subscription_status ?? "")) {
      throw new CheckoutError("trainer_not_ready", "Trainer subscription is not active");
    }
    if (program.capacity !== null) {
      const count = await tx.query(
        `select count(*)::int as n from enrollments
         where program_id = $1 and status in ('pending_acceptance','scheduled','active','paused')`,
        [program.id],
      );
      if (count.rows[0].n >= program.capacity) {
        throw new CheckoutError("capacity_reached", "Program is full");
      }
    }

    const versionRes = await tx.query(
      `select id from program_versions where program_id = $1 order by version desc limit 1`,
      [program.id],
    );
    if (!versionRes.rows[0])
      throw new CheckoutError("program_not_found", "Program has no published version");

    const snapshotRes = await tx.query(
      `insert into program_purchase_snapshots
         (program_id, program_version_id, trainer_id, title, price_cents, currency,
          duration_value, duration_unit, pricing_type, delivery_mode,
          cancellation_terms, refund_policy, included_features)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [
        program.id,
        versionRes.rows[0].id,
        program.trainer_id,
        program.title,
        program.price_cents,
        program.currency,
        program.duration_value,
        program.duration_unit,
        program.pricing_type,
        program.delivery_mode,
        program.cancellation_terms,
        program.refund_policy,
        program.included_features,
      ],
    );

    // Policy-driven transaction commission (0 bps unless an admin enables it).
    const policyRes = await tx.query(
      `select transaction_commission_bps from trainer_billing_policy
       where effective_at <= now() order by effective_at desc limit 1`,
    );
    const commissionBps: number = policyRes.rows[0]?.transaction_commission_bps ?? 0;
    const amount = money(program.price_cents, program.currency);
    const fee = applyBasisPoints(amount, commissionBps);

    const idempotencyKey = `order:${randomUUID()}`;
    const orderRes = await tx.query(
      `insert into orders
         (client_id, trainer_id, program_id, purchase_snapshot_id, status, amount_cents,
          platform_fee_cents, currency, idempotency_key, expires_at)
       values ($1,$2,$3,$4,'created',$5,$6,$7,$8, now() + interval '30 minutes')
       returning id`,
      [
        input.clientUserId,
        program.trainer_id,
        program.id,
        snapshotRes.rows[0].id,
        amount.amountCents,
        fee.amountCents,
        amount.currency,
        idempotencyKey,
      ],
    );
    const orderId: string = orderRes.rows[0].id;

    const session = await gateway.createCheckoutSession({
      orderId,
      clientUserId: input.clientUserId,
      trainerConnectedAccountId: program.stripe_account_id,
      amount,
      applicationFee: fee,
      programTitle: program.title,
      successUrl: `${input.appBaseUrl}/purchases/${orderId}?status=processing`,
      cancelUrl: `${input.appBaseUrl}/programs?checkout=canceled`,
      idempotencyKey,
    });

    await tx.query(
      `update orders set status = 'awaiting_payment', stripe_checkout_session_id = $2 where id = $1`,
      [orderId, session.providerSessionId],
    );
    return { orderId, checkoutUrl: session.url };
  });
}
