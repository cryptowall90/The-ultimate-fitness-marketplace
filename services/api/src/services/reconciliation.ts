import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import type { ReconciliationGateway } from "@fitmarket/payments";
import { dispatchStripeEvent } from "./webhooks.js";

/**
 * Daily reconciliation job (docs/PAYMENTS.md):
 *  1. Dead letters: webhook_events stuck in failed/received older than 15 min
 *     are re-dispatched through the same idempotent handlers.
 *  2. Money comparison: per-day internal sums (payments succeeded, refunds
 *     succeeded) vs provider balance transactions. Differences above
 *     system_settings.billing.reconciliation_alert_threshold_cents are logged
 *     at error level (alerting hooks off logs) and stored on the job run.
 * Locked per calendar day via scheduled_job_runs; a double invocation no-ops.
 */

const DEAD_LETTER_MIN_AGE_MINUTES = 15;
const DEAD_LETTER_MAX_ATTEMPTS = 8;
const DEAD_LETTER_BATCH = 200;
const DEFAULT_ALERT_THRESHOLD_CENTS = 100;

export interface ReconciliationMismatch {
  day: string;
  kind: "charges" | "refunds";
  currency: string;
  internalCents: number;
  providerCents: number;
  differenceCents: number;
}

export interface ReconciliationResult {
  skipped: boolean;
  deadLettersReprocessed: number;
  deadLettersFailed: number;
  daysCompared: number;
  mismatches: ReconciliationMismatch[];
}

interface StoredEventPayload {
  data?: { object?: unknown };
}

export async function runReconciliation(
  pool: pg.Pool,
  gateway: ReconciliationGateway,
  log: Logger,
  now = new Date(),
  lookbackDays = 3,
): Promise<ReconciliationResult> {
  const lockKey = `recon:${now.toISOString().slice(0, 10)}`;
  const jobRes = await pool.query(
    `insert into scheduled_job_runs (job_name, lock_key, status)
     values ('reconciliation', $1, 'running')
     on conflict (job_name, lock_key) where status = 'running' and lock_key is not null
     do nothing
     returning id`,
    [lockKey],
  );
  if (jobRes.rowCount === 0) {
    log.warn({ lockKey }, "reconciliation already running; skipping");
    return {
      skipped: true,
      deadLettersReprocessed: 0,
      deadLettersFailed: 0,
      daysCompared: 0,
      mismatches: [],
    };
  }
  const jobId: string = jobRes.rows[0].id;

  try {
    const { reprocessed, failed } = await reprocessDeadLetters(pool, log);
    const mismatches = await compareWithProvider(pool, gateway, log, now, lookbackDays);

    await pool.query(
      `update scheduled_job_runs
       set status = 'succeeded', finished_at = now(), items_processed = $2, metadata = $3
       where id = $1`,
      [jobId, reprocessed, JSON.stringify({ deadLettersFailed: failed, mismatches })],
    );
    return {
      skipped: false,
      deadLettersReprocessed: reprocessed,
      deadLettersFailed: failed,
      daysCompared: lookbackDays,
      mismatches,
    };
  } catch (err) {
    await pool.query(
      `update scheduled_job_runs set status = 'failed', finished_at = now(), error = $2
       where id = $1`,
      [jobId, (err as Error).message.slice(0, 1000)],
    );
    throw err;
  }
}

async function reprocessDeadLetters(
  pool: pg.Pool,
  log: Logger,
): Promise<{ reprocessed: number; failed: number }> {
  const stuck = await pool.query(
    `select id, event_id, event_type, payload
     from webhook_events
     where status in ('failed', 'received')
       and received_at < now() - make_interval(mins => $1)
       and attempts < $2
     order by received_at asc
     limit $3`,
    [DEAD_LETTER_MIN_AGE_MINUTES, DEAD_LETTER_MAX_ATTEMPTS, DEAD_LETTER_BATCH],
  );

  let reprocessed = 0;
  let failed = 0;
  for (const row of stuck.rows) {
    const payload = row.payload as StoredEventPayload;
    try {
      await dispatchStripeEvent(pool, log, row.event_type, payload.data?.object ?? {});
      await pool.query(
        `update webhook_events
         set status = 'processed', processed_at = now(), attempts = attempts + 1, last_error = null
         where id = $1`,
        [row.id],
      );
      reprocessed += 1;
    } catch (err) {
      failed += 1;
      await pool.query(
        `update webhook_events set status = 'failed', attempts = attempts + 1, last_error = $2
         where id = $1`,
        [row.id, (err as Error).message.slice(0, 1000)],
      );
      log.error(
        { eventId: row.event_id, eventType: row.event_type, err: (err as Error).message },
        "dead-letter reprocess failed",
      );
    }
  }
  return { reprocessed, failed };
}

async function compareWithProvider(
  pool: pg.Pool,
  gateway: ReconciliationGateway,
  log: Logger,
  now: Date,
  lookbackDays: number,
): Promise<ReconciliationMismatch[]> {
  const thresholdRes = await pool.query(
    `select value from system_settings where key = 'billing.reconciliation_alert_threshold_cents'`,
  );
  const threshold = Number(thresholdRes.rows[0]?.value ?? DEFAULT_ALERT_THRESHOLD_CENTS);

  const mismatches: ReconciliationMismatch[] = [];
  for (let offset = lookbackDays; offset >= 1; offset -= 1) {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    dayStart.setUTCDate(dayStart.getUTCDate() - offset);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const day = dayStart.toISOString().slice(0, 10);

    const providerTxs = await gateway.listBalanceTransactions({
      createdGte: dayStart,
      createdLt: dayEnd,
    });
    const providerCharges = new Map<string, number>();
    const providerRefunds = new Map<string, number>();
    for (const tx of providerTxs) {
      if (tx.type === "charge" || tx.type === "payment") {
        providerCharges.set(tx.currency, (providerCharges.get(tx.currency) ?? 0) + tx.amountCents);
      } else if (tx.type === "refund" || tx.type === "payment_refund") {
        // provider refund amounts are negative (money out); compare magnitudes
        providerRefunds.set(
          tx.currency,
          (providerRefunds.get(tx.currency) ?? 0) + Math.abs(tx.amountCents),
        );
      }
    }

    const internalCharges = await pool.query(
      `select currency, coalesce(sum(amount_cents), 0)::bigint as total
       from payments
       where status = 'succeeded' and succeeded_at >= $1 and succeeded_at < $2
       group by currency`,
      [dayStart, dayEnd],
    );
    const internalRefunds = await pool.query(
      `select currency, coalesce(sum(amount_cents), 0)::bigint as total
       from refunds
       where status = 'succeeded' and updated_at >= $1 and updated_at < $2
       group by currency`,
      [dayStart, dayEnd],
    );

    collectMismatches(mismatches, day, "charges", internalCharges.rows, providerCharges, threshold);
    collectMismatches(mismatches, day, "refunds", internalRefunds.rows, providerRefunds, threshold);
  }

  for (const mismatch of mismatches) {
    // No amounts are secret here; alert channels watch error-level logs.
    log.error(mismatch as unknown as Record<string, unknown>, "reconciliation mismatch");
  }
  return mismatches;
}

function collectMismatches(
  out: ReconciliationMismatch[],
  day: string,
  kind: "charges" | "refunds",
  internalRows: { currency: string; total: string | number }[],
  providerTotals: Map<string, number>,
  threshold: number,
): void {
  const currencies = new Set<string>([
    ...internalRows.map((r) => r.currency.trim()),
    ...providerTotals.keys(),
  ]);
  for (const currency of currencies) {
    const internalCents = Number(
      internalRows.find((r) => r.currency.trim() === currency)?.total ?? 0,
    );
    const providerCents = providerTotals.get(currency) ?? 0;
    const differenceCents = providerCents - internalCents;
    if (Math.abs(differenceCents) > threshold) {
      out.push({ day, kind, currency, internalCents, providerCents, differenceCents });
    }
  }
}
