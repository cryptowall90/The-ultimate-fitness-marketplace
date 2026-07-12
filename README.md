# FitMarket — fitness trainer marketplace

A production-grade marketplace where clients discover, purchase from, message and review
online or in-person personal trainers, and trainers run their business through a
professional CRM.

- **Web** (`apps/web`): Next.js — public marketplace, auth, client portal, trainer CRM, admin.
- **Mobile** (`apps/mobile`): Expo React Native — client & trainer app.
- **Privileged API** (`services/api`): Hono — Stripe webhooks, checkout, billing jobs.
- **Database** (`packages/database`): PostgreSQL (Supabase) + PostGIS, SQL migrations,
  default-deny RLS, DB/RLS test suite.
- Shared packages: `domain`, `validation`, `types`, `payments`, `media`, `notifications`,
  `observability`, `ui`, `config`.

## Business model

- Clients are free.
- Trainers pay **$34.99/month** (Stripe Billing) plus **$2.50 per active client per billing
  cycle**, computed server-side into an append-only ledger with a per-period uniqueness
  constraint (see `docs/BILLING.md`).
- Client purchases flow through Stripe Connect (destination charges); an optional platform
  transaction commission is policy-driven and **disabled by default** (see `docs/PAYMENTS.md`).

## Quick start

Requirements: Node ≥ 22, pnpm 10, PostgreSQL 16 + PostGIS (local script provided).

```bash
pnpm install
packages/database/scripts/dev-db.sh start        # Postgres 16 + PostGIS on :54329
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/fitmarket
pnpm db:reset && pnpm db:seed

pnpm typecheck && pnpm lint && pnpm test:unit
pnpm test:db          # RLS + constraint suite (real database)
pnpm test:api         # webhook/checkout/billing integration tests

# apps (fill the .env.example files first)
pnpm --filter @fitmarket/web dev
pnpm --filter @fitmarket/api dev
pnpm --filter @fitmarket/mobile start
```

## Security posture (short version)

- RLS on every exposed table, default deny; write privileges to payment/billing tables are
  revoked from client roles entirely.
- Stripe webhooks are the only source of payment truth: signature-verified, deduplicated by
  event id, idempotent, out-of-order tolerant.
- Money is integer minor units with currency on every record. Financial ledgers are
  append-only (trigger-enforced).
- Trainer exact addresses never leave the database; search uses coarse public points and
  labels through capped SQL functions.
- See `docs/SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/RLS_POLICY_MATRIX.md`.

## Documentation

Start with `docs/ARCHITECTURE.md`, then `docs/IMPLEMENTATION_STATUS.md` for the current
state and roadmap. `CLAUDE.md` defines the non-negotiable engineering rules.
