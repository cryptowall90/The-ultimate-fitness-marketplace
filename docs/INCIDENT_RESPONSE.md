# Incident response runbooks

Severity: SEV1 payment integrity/data breach · SEV2 feature outage · SEV3 degraded.
First steps always: note time, assign correlation ids, snapshot evidence, open an incident
doc, communicate status.

## Payment/webhook failures

Symptoms: `webhook_events` rows stuck `failed`/`received`, alert on dead letters.
1. `select event_type, status, attempts, last_error from webhook_events where status in ('failed','received') order by received_at` — identify the handler.
2. Fix cause; re-process by re-sending from the Stripe dashboard (dedupe makes replays safe)
   or run the recovery job that re-fetches recent events.
3. Reconcile: compare orders/payments against Stripe for the window; ledger corrections only
   as compensating entries with an `admin_actions` reason.

## Billing job failure / double-charge report

1. `scheduled_job_runs` for `active_client_billing` — status/error.
2. The unique index makes double ledger rows impossible; if Stripe shows a duplicate invoice
   item, its idempotency key identifies the ledger row — void the item, mark the row
   `voided` with reason.
3. Re-run the job; it is idempotent.

## Elevated auth failures / credential stuffing

Alert source: auth failure rate. Enable Turnstile flag, tighten Cloudflare rate rules,
check for token leaks (bundle scan, gitleaks), rotate anon keys if implicated, force
session revocation for affected accounts.

## Database exhaustion

`/readyz` failing or connection errors: check pool saturation, long queries
(`pg_stat_activity`), kill runaways, scale tier. Statement timeout (15 s) bounds damage.

## Data breach (SEV1)

Contain (revoke keys/sessions, disable affected routes) → assess scope via audit logs →
preserve evidence → legal/notification obligations per PRIVACY.md → rotate all secrets →
post-mortem with ADR if architecture changes.

## Suspension of a trainer mid-billing

Use admin action (reason + audit). Entitlements of their clients stay honored or refunded
per policy; billing ledger untouched (compensating entries for goodwill credits).
