# Testing

## Suites (all runnable today)

| Suite | Command | What it proves |
| --- | --- | --- |
| Domain unit (32) | `pnpm --filter @fitmarket/domain test` | money integrity, state machines, billing rules incl. timezone boundaries, Bayesian ratings, review eligibility |
| Validation (16) | `pnpm --filter @fitmarket/validation test` | strict schemas, mass-assignment rejection, honeypot, rating bounds, radius/page caps, form-template validation |
| Payments (6) | `pnpm --filter @fitmarket/payments test` | real Stripe signature verification, forgery/replay/stale-timestamp rejection |
| Media (9) | `pnpm --filter @fitmarket/media test` | magic-byte sniffing, SVG/polyglot rejection, image-bomb caps, random keys |
| Observability (2) | `pnpm --filter @fitmarket/observability test` | redaction of secrets/PII, correlation ids |
| DB + RLS (49) | `pnpm test:db` (real Postgres+PostGIS) | cross-tenant attacks, privilege revocation, immutability, state machines, geo caps + EXPLAIN, review integrity |
| API integration (13) | `pnpm test:api` (real Postgres) | auth, checkout, webhook dedupe/idempotency, refund revocation, billing job double-run |
| Web E2E | `pnpm --filter @fitmarket/web e2e` | smoke + security headers + client-bundle secret scan (needs env) |
| Mobile E2E | `maestro test apps/mobile/.maestro/smoke.yaml` | launch + tab navigation + auth screen (needs simulator/device build) |

## The 15 critical tests → where they live

1. Client A ↛ Client B private record — `rls-tenancy.test.ts`
2. Trainer A ↛ Trainer B clients — `rls-tenancy.test.ts`
3. Trainer ↛ client before relationship — `rls-tenancy.test.ts`
4. Expired enrollment blocks new messages — `rls-messaging-reviews.test.ts`
5. Expired entitlement blocks content — `rls-messaging-reviews.test.ts`
6. Frontend-manipulated payment ⇒ no access — `billing-payments.test.ts` + `checkout-webhook.test.ts`
7. Duplicate webhook ⇒ no duplicates — `billing-payments.test.ts` + `checkout-webhook.test.ts`
8. One enrollment charged once/period — `billing-payments.test.ts` + `billing-job.test.ts`
9. Review requires eligible enrollment — `rls-messaging-reviews.test.ts`
10. Rating outside 1–5 rejected — validation + DB tests
11. Private progress photo ↛ unrelated user — `rls-tenancy.test.ts`
12. Service-role key absent from bundles — CI bundle scan + Playwright spec
13. Trainer home address absent publicly — `rls-tenancy.test.ts` (search function scan)
14. SVG/polyglot upload rejected — `media/test/validation.test.ts`
15. Geo search radius + pagination caps — `search.test.ts`

## Load tests (k6, to run against staging)

Planned scenarios (Phase 9): trainer search, profile reads, program listing, messaging
pagination, login rate limiting, checkout-session creation, webhook processing, CRM client
list, review submission. Targets: public API p95 < 500 ms cached reads, search p95 <
800 ms, critical mutations p95 < 1 s (excluding Stripe confirmation).

## Backup/restore verification

Documented in `BACKUP_AND_RECOVERY.md`; the restore drill is a Phase 9 gate.
