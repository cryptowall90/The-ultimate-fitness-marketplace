# Deployment

## Environments

- **development**: local Postgres (dev-db.sh) or a personal Supabase project.
- **staging**: dedicated Supabase project + Stripe test mode + preview web deploys.
- **production**: separate Supabase project, Stripe live mode, manual promotion only.
  No production personal data ever flows into lower environments.

## Components

| Component | Target | Notes |
| --- | --- | --- |
| apps/web | Vercel (or CF Pages) | env: NEXT_PUBLIC_* only; preview per PR |
| services/api | Fly.io/Railway/Render container | `pnpm --filter @fitmarket/api build`; secrets via platform secret manager |
| database | Supabase | apply `packages/database/migrations` via CI step (psql/supabase cli) |
| cron | platform scheduler / Supabase cron | POST job endpoints with JOB_TOKEN: expire-entitlements (hourly), active-client-billing (daily), reconciliation (daily) |
| edge | Cloudflare | DNS, WAF managed rules, bot fight, rate rules, Turnstile keys |

## Release flow

PR → CI (format/lint/type/unit/db-rls/api/build/audit/gitleaks + bundle scan) → preview →
staging auto-deploy → **manual approval** → production. Protected branches; least-privilege
deploy tokens; use OIDC workload identity where the platform supports it (no long-lived
cloud keys). Feature flags gate risky features; mobile releases roll out gradually
(EAS staged rollout) with signed builds.

## Migrations in production

1. Backup/snapshot first (automatic PITR on Supabase; still take a manual snapshot tag).
2. Apply forward-only migrations; never destructive without a documented review + rollback
   plan (compensating migration).
3. Verify `schema_migrations`, run smoke checks (`/readyz`, key RLS probes).

## Stripe setup (one-time per environment)

Products/prices: `trainer_platform_monthly` lookup key at $34.99. Webhook endpoint →
`/v1/webhooks/stripe` with events: checkout.session.completed, charge.refunded,
charge.dispute.*, account.updated, customer.subscription.*, invoice.paid,
invoice.payment_failed. Store the signing secret only in the API's secret manager.
Connect: Express accounts enabled.
