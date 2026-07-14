import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import type { BalanceGateway } from "@fitmarket/payments";

/**
 * Daily Stripe balance-transaction comparison (docs/PAYMENTS.md §
 * Reconciliation): sums the provider's charge/refund volume for a UTC day
 * and compares it against what the webhooks wrote to `payments`/`refunds`.
 * A delta above `system_settings.billing.reconciliation_alert_threshold_cents`
 * is an alert condition — the job reports and logs, it never "fixes" money.
 */

export interface BalanceReconciliationResult {
  date: string;
  provider: { chargesGrossCents: number; refundsGrossCents: number };
  internal: { chargesGrossCents: number; refundsGrossCents: number };
  chargesDeltaCents: number;
  refundsDeltaCents: number;
  thresholdCents: number;
  alert: boolean;
}

export async function reconcileBalance(
  pool: pg.Pool,
  gateway: BalanceGateway,
  log: Logger,
  dateIso?: string,
): Promise<BalanceReconciliationResult | null> {
  // Default: yesterday UTC — the most recent complete day.
  const date = dateIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

  const jobRes = await pool.query(
    `insert into scheduled_job_runs (job_name, lock_key, status)
     values ('balance_reconciliation', $1, 'running')
     on conflict (job_name, lock_key) where status = 'running' and lock_key is not null
     do nothing
     returning id`,
    [date],
  );
  if (jobRes.rowCount === 0) {
    log.warn({ date }, "balance reconciliation already running for this day; skipping");
    return null;
  }
  const jobId: string = jobRes.rows[0].id;

  try {
    const [provider, internalRes, thresholdRes] = await Promise.all([
      gateway.sumBalanceTransactions({ from, to }),
      pool.query(
        `select
           coalesce((select sum(amount_cents) from payments
                     where succeeded_at >= $1 and succeeded_at < $2), 0)::bigint as charges,
           coalesce((select sum(amount_cents) from refunds
                     where status = 'succeeded'
                       and created_at >= $1 and created_at < $2), 0)::bigint as refunds`,
        [from, to],
      ),
      pool.query(
        `select (value)::int as threshold from system_settings
         where key = 'billing.reconciliation_alert_threshold_cents'`,
      ),
    ]);

    const internal = {
      chargesGrossCents: Number(internalRes.rows[0].charges),
      refundsGrossCents: Number(internalRes.rows[0].refunds),
    };
    const thresholdCents: number = thresholdRes.rows[0]?.threshold ?? 100;
    const chargesDeltaCents = provider.chargesGrossCents - internal.chargesGrossCents;
    const refundsDeltaCents = provider.refundsGrossCents - internal.refundsGrossCents;
    const alert =
      Math.abs(chargesDeltaCents) > thresholdCents || Math.abs(refundsDeltaCents) > thresholdCents;

    if (alert) {
      log.error(
        { date, chargesDeltaCents, refundsDeltaCents, thresholdCents },
        "balance reconciliation mismatch — provider and internal ledgers disagree",
      );
    }

    await pool.query(
      `update scheduled_job_runs
       set status = 'succeeded', finished_at = now(), items_processed = $2,
           error = case when $3 then 'mismatch above threshold' end
       where id = $1`,
      [jobId, Math.abs(chargesDeltaCents) + Math.abs(refundsDeltaCents), alert],
    );
    return {
      date,
      provider,
      internal,
      chargesDeltaCents,
      refundsDeltaCents,
      thresholdCents,
      alert,
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
