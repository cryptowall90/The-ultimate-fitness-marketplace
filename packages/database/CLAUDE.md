# packages/database — instructions

These rules extend the root CLAUDE.md; they never weaken it.

- Migrations are forward-only, ordered SQL files in `migrations/`. Never edit an applied
  migration — add a new one.
- `migrations-local/0000_supabase_shim.sql` is applied automatically ONLY when the `auth`
  schema is missing (plain PostgreSQL). It emulates Supabase (`auth.users`, `auth.uid()`,
  anon/authenticated/service_role roles). Never apply it to Supabase; never put app schema in it.
- Every new table: enable RLS in the same migration, add explicit policies per operation,
  and add cross-tenant tests in `test/`.
- Financial tables (`payment_ledger`, `active_client_billing_ledger`, `program_versions`,
  `program_purchase_snapshots`, `admin_actions`, `audit_logs`) are append-only/immutable —
  enforced by triggers. Do not remove those triggers.
- Client-role write privileges on payment/billing/enrollment tables are REVOKEd — writes go
  through the privileged server only. Keep the revokes when altering grants.
- RLS helper functions live in the `app` schema as SECURITY DEFINER with
  `set search_path = public`. Keep them STABLE and fast — they run per-row.
- Search entry points are `app.search_trainers_nearby` / `app.search_trainers_online` with
  hard radius (160 km) and page-size (50) caps in SQL. Never expose raw
  `trainer_service_locations.exact_location` / `exact_address`.
- Test with a real database: `scripts/dev-db.sh start`, then
  `DATABASE_URL=postgres://postgres@127.0.0.1:54329/fitmarket_test pnpm test`.
