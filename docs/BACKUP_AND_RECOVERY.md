# Backup & recovery

## What is backed up

- **PostgreSQL**: Supabase automated daily backups + PITR (Pro tier). Additionally a weekly
  `pg_dump` to R2 with 90-day retention (script in deployment platform cron).
- **Media**: storage buckets replicated by provider; media metadata restores from DB.
- **Configuration**: env var names in `.env.example`s; secret values in the platform secret
  manager (documented owners); Stripe products/webhooks recreated via DEPLOYMENT.md.

## Restore procedure (database)

1. Freeze writes (maintenance mode on API: stop cron, scale API to zero).
2. Restore PITR to a new branch/instance at the chosen timestamp.
3. Run `select count(*) from schema_migrations` and app-level smoke queries; verify latest
   ledger rows against Stripe for the gap window.
4. Repoint DATABASE_URL, unfreeze, run reconciliation job, monitor alerts.

RTO target: 4 h. RPO target: 15 min (PITR) / 7 days (offline dump worst case).

## Restore drill

Quarterly (and a Phase 9 launch gate): restore the weekly dump into a scratch instance,
run `pnpm test:db` pointed at it (validates schema + RLS integrity), record duration and
issues here.

| Date | Restored from | Duration | Result | Notes |
| --- | --- | --- | --- | --- |
| (pending first drill) | | | | |

## Key rotation

Documented rotation order: Supabase service key → API redeploy; Stripe secret/webhook
secret → dual-secret window on the endpoint; JOB_TOKEN → update scheduler; JWT secret →
coordinated with Supabase (forces re-login).
