# Implementation status

Last updated: 2026-07-13 (continuation session: trainer application + admin approval +
reviews UI + program builder + payment reconciliation job + web chat + favorites +
trainer billing/payout screens + CRM core screens + moderation portal + client coaching view +
media signed-upload flow)

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
- ✅ Trainer application UI (`/trainer/apply`: draft profile + specialties + credentials,
  draft→submitted via RLS/trigger) and admin approval (`/admin/trainer-applications` UI +
  `services/api /v1/admin/trainer-applications` list/approve/reject with admin role check,
  trainer role grant, and immutable admin_actions audit rows) — verified by 7 API
  integration tests + owner-lifecycle RLS test
- ✅ Media signed-upload flow: POST /v1/media/uploads (per-kind mime/size policy, per-user
  quota from system_settings, random object keys) + /complete (server reads the bytes back,
  magic-byte signature must match the declared type; images publish, documents quarantine
  for the scan job; failures are rejected and the object deleted) — Supabase Storage
  provider implementation + 7 integration tests
- ✅ Avatar upload UI on /account (client-side resize/re-encode strips EXIF, signed-upload
  flow, avatar_media_id set only after server verification publishes) + avatar display on
  the public trainer profile
- ✅ Credential-document upload on /trainer/apply (PDF via signed-upload flow, quarantined
  for scanning; server action verifies the media row is the caller's own private document
  before attaching document_media_id)
- ⬜ TOTP MFA enrollment UI (Supabase supports; enforcement flag seeded)

## Phase 2 — Search: 🟡 core done

- ✅ PostGIS locations, GIST index, capped SECURITY DEFINER search functions (radius ≤160 km,
  page ≤50, keyset pagination), public RPC wrappers, EXPLAIN-verified index use
- ✅ Online search with trigram/FTS relevance + Bayesian-rating ranking
- ✅ Web search page (online + in-person via launch-city table), mobile Discover/Search
- ✅ Favorites schema + RLS
- 🟡 External geocoding adapter (contract documented; static launch-city table shipping)
- ✅ Favorites UI: save/unsave on trainer profiles, saved-trainers list on /account
  (RLS-scoped; unpublished trainers drop out via the join policy)
- ⬜ k6 load tests

## Phase 3 — Programs: 🟡 core done

- ✅ Schema: programs (status state machine), immutable versions on publish, immutable
  purchase snapshots; capacity; RLS (owner write, public read of published)
- ✅ Program display + purchase on trainer profile (web)
- ✅ Trainer program builder (`/trainer/programs`): create drafts, edit, publish/pause/
  archive via the DB state machine; editing a live program bumps the version and snapshots
  it (owner-path lifecycle covered by a DB test); money parsed to integer cents, no floats
- ⬜ Admin program moderation UI

## Phase 4 — Payments & enrollment: ✅ core complete (verified by 13 integration tests)

- ✅ Checkout endpoint (DB-priced, policy commission default 0, capacity checks)
- ✅ Webhooks: signature verification, event-id dedupe, idempotent handlers for checkout,
  refunds (access revocation), disputes, connect account, subscription lifecycle, invoices
- ✅ Enrollment state machine (TS + DB), entitlements, conversation bootstrap, CRM record
- ✅ Append-only payment_ledger, refunds/disputes/transfers/payouts tables
- ✅ Purchase status page reflecting webhook-written state only
- ✅ Reconciliation job (`/v1/jobs/reconcile-payments`): dead-letter replay through the
  idempotent handlers with an 8-attempt abandonment cap, stale-order expiry (1h margin),
  paid-order-without-enrollment invariant alert — 5 integration tests
- 🟡 Stripe balance-transaction comparison + missing-webhook recovery (need provider list
  APIs; documented in PAYMENTS.md)
- ⬜ Trainer-initiated refund UI

## Phase 5 — Trainer billing: ✅ core complete (verified)

- ✅ $34.99 subscription checkout + lifecycle (trial/past_due/grace/suspension incl.
  auto-unpublish), periods per Stripe invoice period
- ✅ $2.50 active-client job: lock, domain rules, unique-per-period ledger, deterministic
  Stripe invoice-item idempotency, finalization on invoice.paid — double-run tested
- ✅ Entitlement/enrollment expiry job (conversations become read-only)
- ✅ Trainer billing screen (/trainer/settings/billing: policy-priced subscription checkout
  via services/api, status incl. past-due/grace warnings, period history, active-client
  charges) and payouts screen (/trainer/settings/payouts: Connect onboarding status +
  link) — all reads owner-select RLS; all state written by webhooks/jobs only

## Phase 6 — Messaging & reviews: 🟡 data/authz complete

- ✅ Conversations per enrollment, participant/entitlement/block-gated sends (RLS-tested),
  receipts, attachments schema, read-only after expiry
- ✅ Reviews: enrollment-gated insert, one-per-enrollment, 1–5 integer, trainer
  response-only guard, moderation history, Bayesian aggregates, public read of published
- ✅ Mobile conversations list; web review display
- ✅ Review submission form on the purchase page (enrollment-gated via RLS `can_review`,
  one per enrollment, shared Zod schema on the server action)
- ✅ Web chat: /messages conversation list + live thread (anon-key client only — RLS gates
  reads, sends and receipts; Realtime INSERT subscription with reload fallback; read-only
  banner after expiry; sender id always from the session)
- ⬜ Mobile chat thread UI, notification adapters wired

## Phase 7 — CRM: 🟡 schema/RLS complete

- ✅ All CRM tables + tenant isolation (pipeline, leads, records, tags, notes split
  private/visible, tasks + dedup-safe reminders, versioned forms, check-ins, measurements,
  progress photos with sharing flag, documents)
- ✅ CRM core screens (/trainer/crm overview with roster + open tasks; client detail with
  private notes, client-visible notes/assignments, tasks add/complete, check-in history) —
  new shared Zod schemas in @fitmarket/validation (crm.ts); owner RLS on every query
- ✅ Client coaching view (/coaching): shared notes/assignments with mark-complete, check-in
  schedule — client-side RLS policies only
- ⬜ CRM Leads/Calendar/Forms/Analytics screens

## Phase 8 — Administration & compliance: 🟡 foundations

- ✅ reports/moderation_cases with case-gated conversation access; immutable
  admin_actions/audit_logs; feature flags; system settings; job runs; export/deletion
  requests; consent records
- ✅ Moderation portal core: /admin/moderation queue UI + services/api
  /v1/moderation/reports list/dismiss/action endpoints (moderator role check; content
  removal for review/message targets in service context with rating recompute; every
  decision writes admin_actions) — 5 integration tests
- ⬜ Moderation case management/escalation UI, admin portal (settings/flags), export/
  deletion job workers, appeals workflow UI

## Phase 9 — Hardening: 🟡 started

- ✅ Durable rate limiter: Postgres-backed token bucket (rate_limit_buckets, service-only
  RLS + migration 0014) on all per-account expensive routes — atomic upsert, correct across
  instances, fails open with a logged warning on DB errors; stale buckets pruned by the
  reconciliation job — 5 tests incl. shared-budget-across-instances + RLS denial test
- ⬜ k6 load tests, CSP nonces (drop 'unsafe-inline'), restore drill, incident drill,
  accessibility audit, app-store readiness

## Verification snapshot (this session)

| Check | Result |
| --- | --- |
| `pnpm typecheck` (all 13 workspaces) | ✅ |
| `pnpm lint` | ✅ |
| `pnpm format:check` | ✅ |
| Unit tests (domain 32, validation 16, payments 6, media 9, observability 2) | ✅ 65 passed |
| DB/RLS tests vs real PG16+PostGIS | ✅ 52 passed |
| API integration tests (webhooks/billing/approvals/reconciliation/moderation/media/ratelimit) | ✅ 42 passed |
| `next build` + bundle secret scan | ✅ |
| `pnpm --filter @fitmarket/api build` | ✅ |
| Mobile `tsc --noEmit` | ✅ (react type resolution pinned in tsconfig — pnpm hidden-hoist
of @types/react is order-dependent between the React 19 web app and React 18 mobile app) |

## Top remaining risks

1. UI coverage lags the data layer (CRM/admin/chat screens) — tracked per phase above.
2. Geocoding adapter and Stripe balance-transaction comparison are designed but not coded.
3. CSP still allows inline scripts (Next bootstrap) until nonce wiring (Phase 9).
