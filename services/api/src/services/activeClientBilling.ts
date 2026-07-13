import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import type { SubscriptionGateway } from "@fitmarket/payments";
import {
  computeBillableLineItems,
  money,
  type BillableEnrollmentCandidate,
} from "@fitmarket/domain";

/**
 * Active-client billing job. Idempotent and safe to re-run:
 *  - a job-level lock row prevents concurrent runs per period,
 *  - the domain layer dedupes candidates,
 *  - the acbl_once_per_period unique index is the final guarantee,
 *  - Stripe invoice items use the ledger row's deterministic idempotency key.
 *
 * Billable counts are computed here, server-side, from enrollments — never
 * from anything a client sent.
 */
export async function runActiveClientBilling(
  pool: pg.Pool,
  gateway: SubscriptionGateway,
  log: Logger,
  now = new Date(),
): Promise<{ trainersProcessed: number; lineItemsCreated: number }> {
  const lockKey = `acb:${now.toISOString().slice(0, 10)}`;
  const jobRes = await pool.query(
    `insert into scheduled_job_runs (job_name, lock_key, status)
     values ('active_client_billing', $1, 'running')
     on conflict (job_name, lock_key) where status = 'running' and lock_key is not null
     do nothing
     returning id`,
    [lockKey],
  );
  if (jobRes.rowCount === 0) {
    log.warn({ lockKey }, "active-client billing already running; skipping");
    return { trainersProcessed: 0, lineItemsCreated: 0 };
  }
  const jobId: string = jobRes.rows[0].id;

  let trainersProcessed = 0;
  let lineItemsCreated = 0;
  try {
    const policyRes = await pool.query(
      `select active_client_fee_cents, currency from trainer_billing_policy
       where effective_at <= now() order by effective_at desc limit 1`,
    );
    const policy = policyRes.rows[0];
    if (!policy) throw new Error("no billing policy configured");
    const fee = money(policy.active_client_fee_cents, policy.currency.trim());

    // Trainers with an open billing period covering "now".
    const trainers = await pool.query(
      `select tsp.trainer_id, tsp.period_start, tsp.period_end, tsa.stripe_customer_id
       from trainer_subscription_periods tsp
       join trainer_subscription_accounts tsa on tsa.trainer_id = tsp.trainer_id
       where tsp.status = 'open'
         and tsa.status in ('trialing','active','past_due','grace_period')
       order by tsp.trainer_id`,
    );

    for (const trainer of trainers.rows) {
      const period = {
        start: new Date(trainer.period_start),
        end: new Date(trainer.period_end),
      };
      const candidatesRes = await pool.query(
        `select en.id as enrollment_id, en.client_id, en.status,
                en.actual_start_at, en.access_ends_at, en.refunded_at,
                (en.refunded_at is not null and en.actual_start_at is not null
                 and en.refunded_at <= en.actual_start_at) as fully_refunded_before_access
         from enrollments en
         where en.trainer_id = $1
           and en.status in ('active','paused','completed','expired','terminated','refunded')
           and en.actual_start_at is not null
           and en.actual_start_at < $3
           and coalesce(least(en.access_ends_at, en.refunded_at), 'infinity'::timestamptz) > $2`,
        [trainer.trainer_id, period.start, period.end],
      );
      const billedRes = await pool.query(
        `select enrollment_id from active_client_billing_ledger
         where trainer_id = $1 and trainer_billing_period_start = $2`,
        [trainer.trainer_id, period.start],
      );
      const alreadyBilled = new Set<string>(billedRes.rows.map((r) => r.enrollment_id));

      const candidates: BillableEnrollmentCandidate[] = candidatesRes.rows.map((r) => ({
        enrollmentId: r.enrollment_id,
        clientId: r.client_id,
        status: r.status,
        actualStartAt: r.actual_start_at ? new Date(r.actual_start_at) : null,
        accessEndsAt: r.access_ends_at ? new Date(r.access_ends_at) : null,
        refundedAt: r.refunded_at ? new Date(r.refunded_at) : null,
        fullyRefundedBeforeAccess: r.fully_refunded_before_access === true,
      }));

      const items = computeBillableLineItems(
        trainer.trainer_id,
        candidates,
        period,
        fee,
        alreadyBilled,
      );

      for (const item of items) {
        const ledger = await pool.query(
          `insert into active_client_billing_ledger
             (trainer_id, client_id, enrollment_id, trainer_billing_period_start,
              trainer_billing_period_end, amount_cents, currency, status,
              stripe_customer_id, idempotency_key)
           values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
           on conflict (enrollment_id, trainer_billing_period_start) do nothing
           returning id`,
          [
            trainer.trainer_id,
            item.clientId,
            item.enrollmentId,
            period.start,
            period.end,
            item.amountCents,
            item.currency,
            trainer.stripe_customer_id,
            item.idempotencyKey,
          ],
        );
        if (ledger.rowCount === 0) continue; // raced with a concurrent/previous run

        const invoiceItem = await gateway.createInvoiceItem({
          providerCustomerId: trainer.stripe_customer_id,
          amount: money(item.amountCents, item.currency),
          description: `Active client fee (${period.start.toISOString().slice(0, 10)} – ${period.end.toISOString().slice(0, 10)})`,
          idempotencyKey: item.idempotencyKey,
        });
        await pool.query(
          `update active_client_billing_ledger
           set status = 'invoiced', stripe_invoice_item_id = $2
           where id = $1`,
          [ledger.rows[0].id, invoiceItem.providerInvoiceItemId],
        );
        lineItemsCreated += 1;
      }
      if (items.length > 0) {
        await pool.query(
          `update trainer_subscription_periods
           set active_client_count = coalesce(active_client_count, 0) + $2,
               active_client_fee_cents = coalesce(active_client_fee_cents, 0) + $3
           where trainer_id = $1 and period_start = $4`,
          [trainer.trainer_id, items.length, items.length * fee.amountCents, period.start],
        );
      }
      trainersProcessed += 1;
    }

    await pool.query(
      `update scheduled_job_runs set status = 'succeeded', finished_at = now(), items_processed = $2
       where id = $1`,
      [jobId, lineItemsCreated],
    );
    return { trainersProcessed, lineItemsCreated };
  } catch (err) {
    await pool.query(
      `update scheduled_job_runs set status = 'failed', finished_at = now(), error = $2
       where id = $1`,
      [jobId, (err as Error).message.slice(0, 1000)],
    );
    throw err;
  }
}
