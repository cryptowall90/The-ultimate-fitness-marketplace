# Implementation status

Last updated: 2026-07-15 (session 2: trainer application/approval flow, media signed
uploads, reconciliation job)

Legend: ✅ implemented & verified · 🟡 partial (data/authorization layer done, UI pending) ·
⬜ not started

## Phase 0 — Foundation: ✅ complete

- ✅ pnpm monorepo, strict TS, shared ESLint/Prettier/tsconfig (`packages/config`)
- ✅ Root + nested CLAUDE.md (web, mobile, database, payments, services/api)
- ✅ Local Postgres 16 + PostGIS tooling (`dev-db.sh`), migration runner, Supabase shim
- ✅ CI: format, lint, typecheck, unit, DB/RLS + API tests on postgis service container,
  web/api builds, mobile typecheck, `pnpm audit`, gitleaks, client-bundle secret scan
- ✅ Observability package (redacting logger, correlation ids, audit contracts)
- ✅ Documentation skeleton + architecture diagrams + threat model + ADRs 0001–0006

## Phase 1 — Identity & profiles: 🟡 vertical slice done

- ✅ Schema + RLS: users/roles/profiles/client_profiles/trainer_profiles/locations/
  specialties/credentials/availability/terms/consents; signup provisioning trigger;
  approval + credential column guards
- ✅ Web auth: sign-up (honeypot, terms), verification callback (PKCE, open-redirect safe),
  sign-in, password reset — enumeration-resistant
- ✅ Client profile edit (validated server actions); mobile auth with SecureStore
- ✅ Media schema + validation library (magic bytes, SVG ban, bombs, quotas, random keys)
- ✅ Trainer application flow: `/trainer/apply` (draft save/submit with shared Zod schema,
  status cards for submitted/approved/rejected; owner draft→submitted transition RLS-tested)
- ✅ Admin approval: `/admin/trainers` (web) + services/api
  `GET/POST /v1/admin/trainer-applications[...]` — admin-role checked server-side, decision
  audited in `admin_actions`, approval grants trainer role + publishes (10 API tests)
- ✅ Media signed-upload endpoints: `POST /v1/media/uploads` (+ `/:id/complete`) with quota,
  magic-byte verification at finalize, `SupabaseStorageProvider` (fetch-based, no new deps)
- ⬜ Media publish worker (quarantined → processing → published re-encode/variants)
- ⬜ TOTP MFA enrollment UI (Supabase supports; enforcement flag seeded)

## Phase 2 — Search: 🟡 core done

- ✅ PostGIS locations, GIST index, capped SECURITY DEFINER search functions (radius ≤160 km,
  page ≤50, keyset pagination), public RPC wrappers, EXPLAIN-verified index use
- ✅ Online search with trigram/FTS relevance + Bayesian-rating ranking
- ✅ Web search page (online + in-person via launch-city table), mobile Discover/Search
- ✅ Favorites schema + RLS
- 🟡 External geocoding adapter (contract documented; static launch-city table shipping)
- ⬜ Favorites UI, k6 load tests

## Phase 3 — Programs: 🟡 core done

- ✅ Schema: programs (status state machine), immutable versions on publish, immutable
  purchase snapshots; capacity; RLS (owner write, public read of published)
- ✅ Program display + purchase on trainer profile (web)
- ⬜ Trainer program-builder UI, admin program moderation UI

## Phase 4 — Payments & enrollment: ✅ core complete (verified by 13 integration tests)

- ✅ Checkout endpoint (DB-priced, policy commission default 0, capacity checks)
- ✅ Webhooks: signature verification, event-id dedupe, idempotent handlers for checkout,
  refunds (access revocation), disputes, connect account, subscription lifecycle, invoices
- ✅ Enrollment state machine (TS + DB), entitlements, conversation bootstrap, CRM record
- ✅ Append-only payment_ledger, refunds/disputes/transfers/payouts tables
- ✅ Purchase status page reflecting webhook-written state only
- ✅ Reconciliation job `POST /v1/jobs/reconciliation`: dead-letter webhook replay +
  per-day internal-vs-Stripe sums (threshold from system_settings), day-locked via
  `scheduled_job_runs`, mismatches persisted + error-logged (5 integration tests)
- ⬜ Trainer-initiated refund UI

## Phase 5 — Trainer billing: ✅ core complete (verified)

- ✅ $34.99 subscription checkout + lifecycle (trial/past_due/grace/suspension incl.
  auto-unpublish), periods per Stripe invoice period
- ✅ $2.50 active-client job: lock, domain rules, unique-per-period ledger, deterministic
  Stripe invoice-item idempotency, finalization on invoice.paid — double-run tested
- ✅ Entitlement/enrollment expiry job (conversations become read-only)
- ⬜ Trainer billing screens (data + RLS ready)

## Phase 6 — Messaging & reviews: 🟡 data/authz complete

- ✅ Conversations per enrollment, participant/entitlement/block-gated sends (RLS-tested),
  receipts, attachments schema, read-only after expiry
- ✅ Reviews: enrollment-gated insert, one-per-enrollment, 1–5 integer, trainer
  response-only guard, moderation history, Bayesian aggregates, public read of published
- ✅ Mobile conversations list; web review display
- ⬜ Chat UI (web/mobile) with Realtime, review submission form, notification adapters wired

## Phase 7 — CRM: 🟡 schema/RLS complete

- ✅ All CRM tables + tenant isolation (pipeline, leads, records, tags, notes split
  private/visible, tasks + dedup-safe reminders, versioned forms, check-ins, measurements,
  progress photos with sharing flag, documents)
- ⬜ CRM web UI (Overview/Leads/Clients/Calendar/Forms/Analytics screens)

## Phase 8 — Administration & compliance: 🟡 foundations

- ✅ reports/moderation_cases with case-gated conversation access; immutable
  admin_actions/audit_logs; feature flags; system settings; job runs; export/deletion
  requests; consent records
- 🟡 Admin portal UI (trainer application review shipped at `/admin/trainers`; moderation,
  settings and appeals screens pending)
- ⬜ Export/deletion job workers, appeals workflow UI

## Phase 9 — Hardening: ⬜ (targets and gates documented in TESTING/DEPLOYMENT)

- ⬜ k6 load tests, CSP nonces (drop 'unsafe-inline'), durable rate limiter, restore drill,
  incident drill, accessibility audit, app-store readiness

## Verification snapshot (this session)

| Check | Result |
| --- | --- |
| `pnpm typecheck` (all 13 workspaces) | ✅ |
| `pnpm lint` | ✅ |
| `pnpm format:check` | ✅ |
| Unit tests (domain 32, validation 16, payments 6, media 12, observability 2) | ✅ 68 passed |
| DB/RLS tests vs real PG16+PostGIS | ✅ 51 passed |
| API integration tests (webhooks/billing/admin/media/reconciliation) | ✅ 38 passed |
| `next build` | ✅ |
| `pnpm --filter @fitmarket/api build` | ✅ |
| Mobile `tsc --noEmit` | ✅ |

## Top remaining risks

1. UI coverage lags the data layer (CRM/chat screens, broader admin portal) — tracked per
   phase above.
2. Geocoding adapter is designed but not coded; media publish worker
   (re-encode/variants/malware scan) still pending, so uploads stop at `quarantined`.
3. CSP still allows inline scripts (Next bootstrap) until nonce wiring (Phase 9).
4. In-memory rate limiter is single-instance; durable implementation needed before
   horizontal scaling.
