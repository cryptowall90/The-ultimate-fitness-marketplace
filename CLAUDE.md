# CLAUDE.md — Fitness Trainer Marketplace

## Mission

Build and maintain a secure, production-grade, low-cost fitness trainer marketplace where
clients discover, purchase from, message, and review online or in-person personal trainers,
and trainers run their business through a professional CRM.

## Non-negotiable rules

- Read this file before making changes.
- Never bypass authorization. Authorization is enforced server-side AND at the database level.
- RLS is mandatory on every exposed table. Default deny. A new private table without RLS
  policies and RLS tests must not ship.
- Never place privileged secrets (Supabase service-role key, Stripe secret key, webhook
  secrets, Cloudflare tokens) in client applications or public bundles.
- Never trust payment state from a browser or mobile callback. Webhooks + server verification
  are the only sources of payment truth.
- Financial mutations are server-side, idempotent, and auditable.
- Use integer minor currency units (cents) for money. Never floating point. Currency is stored
  on every monetary record.
- Validate all untrusted input at runtime with Zod (`@fitmarket/validation`).
- Never render user-supplied HTML unsafely. No `dangerouslySetInnerHTML` with user content.
- Do not weaken security merely to make a test pass.
- Do not expose trainer residential addresses. Public search returns service-area
  descriptions and coarse coordinates only.
- Do not expose private client fitness data (progress photos, measurements, check-ins)
  outside an authorized trainer-client relationship.
- Do not log tokens, cookies, authorization headers, message bodies, or sensitive fitness data.
  Use the redacting logger from `@fitmarket/observability`.
- Do not introduce a new dependency without explaining why existing dependencies are
  insufficient (in the PR description or an ADR).
- Do not claim completion without running the applicable checks listed below.
- Update documentation and tests with behavior changes.
- Update `docs/IMPLEMENTATION_STATUS.md` after meaningful work.
- Record major architecture decisions in `docs/adr/`.
- Preserve backward compatibility or provide a migration.
- Prefer a modular monolith over premature microservices.
- Optimize for low cost, but never at the expense of authorization, payment integrity, or
  data protection.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/web` | Next.js — public marketplace, auth flows, client portal, trainer CRM, admin portal |
| `apps/mobile` | Expo React Native — client and trainer mobile app |
| `packages/ui` | Shared design-system components (web) |
| `packages/types` | Shared TypeScript types, enums, DTOs |
| `packages/validation` | Shared Zod schemas (single source of runtime validation) |
| `packages/config` | Shared tsconfig, ESLint, env-validation helpers |
| `packages/database` | SQL migrations, migration runner, seeds, DB + RLS tests |
| `packages/domain` | Framework-independent business rules (state machines, billing, money, reviews) |
| `packages/payments` | Payment/billing/connect gateway interfaces + Stripe implementation |
| `packages/media` | Media-provider interfaces, upload validation, image rules |
| `packages/notifications` | Email/push/in-app notification provider interfaces |
| `packages/observability` | Redacting structured logger, correlation IDs, audit helpers |
| `services/api` | Privileged server (Hono): Stripe webhooks, checkout, billing jobs |
| `docs/` | Architecture, security, payments, billing, runbooks, ADRs, status |
| `.github/workflows` | CI |

Migrations live in `packages/database/migrations` (plain SQL, ordered, forward-only).
DB/RLS tests live in `packages/database/test`.

## Commands

Run from the repo root. Requires Node >= 22 and pnpm 10.

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Local database start | `packages/database/scripts/dev-db.sh start` (Postgres 16 + PostGIS on port 54329) |
| Database reset | `pnpm db:reset` (drops + recreates + migrates the dev database) |
| Database migrate | `pnpm db:migrate` |
| Seed | `pnpm db:seed` |
| Lint | `pnpm lint` |
| Format check | `pnpm format:check` |
| Typecheck | `pnpm typecheck` |
| Unit tests | `pnpm test:unit` |
| DB + RLS tests | `pnpm test:db` (requires local database running) |
| API integration tests | `pnpm test:api` (requires local database running) |
| All tests | `pnpm test` |
| Web dev | `pnpm --filter @fitmarket/web dev` |
| Web build | `pnpm --filter @fitmarket/web build` |
| Web E2E | `pnpm --filter @fitmarket/web e2e` (Playwright) |
| Mobile dev | `pnpm --filter @fitmarket/mobile start` |
| Mobile typecheck | `pnpm --filter @fitmarket/mobile typecheck` |
| Mobile E2E | Maestro flows in `apps/mobile/.maestro` (documented in docs/TESTING.md) |
| Build all | `pnpm build` |
| Security scan | `pnpm audit --prod` + CI secret scanning (gitleaks) |
| Generate DB types | `pnpm --filter @fitmarket/database gen:types` |

## Definition of done

A task is done only when:

- Requirements are implemented (no stubs presented as working features).
- Authorization is enforced server-side and at the database level (RLS).
- Inputs are validated with shared Zod schemas.
- Errors are handled safely (no secret/PII leakage in messages or logs).
- Tests cover success, failure, and unauthorized cases.
- Applicable commands above pass.
- Documentation is updated.
- No placeholder or dead interface remains in shipped UI.
- No secret is committed.
- `docs/IMPLEMENTATION_STATUS.md` is updated.

## Payment rules

- Stripe webhooks are authoritative for payment state.
- Verify Stripe signatures on every webhook; reject on failure.
- Store and deduplicate webhook event IDs in `webhook_events` before processing.
- Use idempotency keys on every payment mutation (client → Stripe and internal).
- Never grant program access solely from a redirect or client callback.
- Reconcile internal ledger and Stripe records with scheduled jobs; alert on mismatch.
- Financial ledger records (`payment_ledger`, `active_client_billing_ledger`) are append-only.
  Never destructively edit; use compensating/void entries.
- Active-client billing has a database uniqueness constraint per (enrollment, billing period).
- The platform transaction commission is policy-driven (`trainer_billing_policy` /
  `system_settings`), default 0, admin-configurable — never hardcoded.

## Database rules

- Migration-first. No manual production schema drift.
- Foreign keys are mandatory where relational integrity applies.
- Add indexes based on real query shapes; document them in docs/DATA_MODEL.md.
- Use transactions for multi-record state changes.
- RLS default deny; explicit policies per operation.
- Add RLS tests with every new private table (`packages/database/test`).
- Avoid unbounded queries — cursor pagination with server-enforced limits.
- Avoid JSONB for data that belongs in relational columns. JSONB is only for provider
  payload snapshots and versioned flexible configuration (form field definitions).

## Security checklist (apply to every change)

- AuthN: Supabase Auth; email verification; optional TOTP MFA; session rotation/revocation;
  reauthentication for sensitive actions.
- AuthZ: RLS + server-side checks; object-level authorization on every endpoint; no
  client-controlled IDs used as trust input.
- Validation: Zod on every boundary; reject unknown keys on privileged inputs (mass-assignment).
- Output encoding: React default escaping only; sanitize any rich text server-side.
- CSRF: SameSite=Lax cookies + origin checks on cookie-authenticated mutations.
- CORS: strict allowlist in services/api.
- Headers: CSP (frame-ancestors 'none'), HSTS, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy — configured in apps/web and services/api.
- File upload: magic-byte MIME verification, size/dimension caps, no SVG, random object keys,
  quarantine before publish, signed short-lived URLs.
- SSRF: outbound fetches only through the geocoding/webhook adapters with URL allowlists.
- Rate limiting: per-route, per-account, per-IP; exponential backoff on auth flows.
- Logging: redacting logger only; correlation IDs; no secrets/PII.
- Secrets: env-validated at startup; server-only vars never referenced in client code.
- Dependencies: pinned versions, lockfile committed, CI audit + secret scanning.
- Audit: privileged/admin/financial actions write `audit_logs` / `admin_actions`.

## Working method

For each task:

1. Inspect the relevant packages, migrations, and docs.
2. Plan the smallest complete vertical slice.
3. Implement it (schema → domain → API → UI as needed).
4. Run focused tests for the changed area.
5. Run broader checks (`pnpm typecheck`, `pnpm lint`, affected test suites).
6. Review security and tenant isolation for the change (see checklist above).
7. Update docs and `docs/IMPLEMENTATION_STATUS.md`.
8. Report exact files changed, commands run, results, and remaining risks.

Nested CLAUDE.md files exist in `apps/web`, `apps/mobile`, `packages/database`,
`packages/payments`, and `services/api`. Nested instructions must not weaken the rules above.
