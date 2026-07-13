import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import { dispatchStripeEvent } from "./webhooks.js";

/**
 * Payment reconciliation job (docs/PAYMENTS.md § Reconciliation). Idempotent
 * and safe to re-run on a schedule:
 *
 *  1. Dead-letter replay — webhook_events stuck in 'failed', or in
 *     'received'/'processing' for 15+ minutes (crashed mid-flight), are
 *     re-dispatched through the same idempotent handlers. Rows that keep
 *     failing are abandoned after MAX_ATTEMPTS for a human (runbook:
 *     INCIDENT_RESPONSE.md).
 *  2. Order expiry — orders never paid are moved to 'expired' one hour after
 *     their checkout window closed. The margin leaves room for a late
 *     webhook; a genuinely late payment then lands as a dead letter and is
 *     surfaced instead of silently double-handled.
 *  3. Invariant check — paid orders with no enrollment after 15 minutes are
 *     counted and logged; a non-zero count means the webhook path lost work
 *     and requires investigation.
 *
 * Stripe balance-transaction comparison (daily totals vs ledger) needs the
 * provider's list APIs and is tracked separately in IMPLEMENTATION_STATUS.
 */

const MAX_ATTEMPTS = 8;
const DEAD_LETTER_BATCH = 200;

export interface ReconciliationResult {
  deadLettersReplayed: number;
  deadLettersStillFailing: number;
  deadLettersAbandoned: number;
  ordersExpired: number;
  paidOrdersMissingEnrollment: number;
}

export async function runPaymentReconciliation(
  pool: pg.Pool,
  log: Logger,
): Promise<ReconciliationResult> {
  const jobRes = await pool.query(
    `insert into scheduled_job_runs (job_name, lock_key, status)
     values ('payment_reconciliation', 'reconcile', 'running')
     on conflict (job_name, lock_key) where status = 'running' and lock_key is not null
     do nothing
     returning id`,
  );
  if (jobRes.rowCount === 0) {
    log.warn("payment reconciliation already running; skipping");
    return {
      deadLettersReplayed: 0,
      deadLettersStillFailing: 0,
      deadLettersAbandoned: 0,
      ordersExpired: 0,
      paidOrdersMissingEnrollment: 0,
    };
  }
  const jobId: string = jobRes.rows[0].id;

  const result: ReconciliationResult = {
    deadLettersReplayed: 0,
    deadLettersStillFailing: 0,
    deadLettersAbandoned: 0,
    ordersExpired: 0,
    paidOrdersMissingEnrollment: 0,
  };

  try {
    // 1. Dead-letter replay.
    const deadLetters = await pool.query(
      `select id, event_type, payload, attempts from webhook_events
       where (
           status = 'failed'
           or (status in ('received', 'processing')
               and received_at <= now() - interval '15 minutes')
         )
         and attempts < $1
       order by received_at
       limit $2`,
      [MAX_ATTEMPTS, DEAD_LETTER_BATCH],
    );
    for (const row of deadLetters.rows) {
      const data = (row.payload as { data?: { object?: unknown } })?.data?.object;
      try {
        if (data === undefined) throw new Error("payload has no data.object");
        await dispatchStripeEvent(pool, log, row.event_type, data);
        await pool.query(
          `update webhook_events
           set status = 'processed', processed_at = now(), attempts = attempts + 1
           where id = $1`,
          [row.id],
        );
        result.deadLettersReplayed += 1;
      } catch (err) {
        const attempts: number = row.attempts + 1;
        await pool.query(
          `update webhook_events set status = 'failed', attempts = $2, last_error = $3
           where id = $1`,
          [row.id, attempts, (err as Error).message.slice(0, 1000)],
        );
        if (attempts >= MAX_ATTEMPTS) {
          result.deadLettersAbandoned += 1;
          log.error(
            { webhookEventId: row.id, eventType: row.event_type, attempts },
            "dead-letter abandoned after max attempts — manual intervention required",
          );
        } else {
          result.deadLettersStillFailing += 1;
        }
      }
    }

    // 2. Expire stale unpaid orders (1h past the checkout window).
    const expired = await pool.query(
      `update orders set status = 'expired'
       where status in ('created', 'awaiting_payment')
         and expires_at is not null
         and expires_at <= now() - interval '1 hour'
       returning id`,
    );
    result.ordersExpired = expired.rowCount ?? 0;

    // 3. Invariant: every paid order has an enrollment.
    const missing = await pool.query(
      `select o.id from orders o
       where o.status = 'paid'
         and o.updated_at <= now() - interval '15 minutes'
         and not exists (select 1 from enrollments en where en.order_id = o.id)
       limit 50`,
    );
    result.paidOrdersMissingEnrollment = missing.rowCount ?? 0;
    if (missing.rowCount) {
      log.error(
        { orderIds: missing.rows.map((r) => r.id) },
        "paid orders without enrollments detected — webhook path lost work",
      );
    }

    await pool.query(
      `update scheduled_job_runs
       set status = 'succeeded', finished_at = now(), items_processed = $2
       where id = $1`,
      [jobId, result.deadLettersReplayed + result.ordersExpired],
    );
    return result;
  } catch (err) {
    await pool.query(
      `update scheduled_job_runs set status = 'failed', finished_at = now(), error = $2
       where id = $1`,
      [jobId, (err as Error).message.slice(0, 1000)],
    );
    throw err;
  }
}
