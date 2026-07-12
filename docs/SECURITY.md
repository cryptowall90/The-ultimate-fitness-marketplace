# Security

Baseline: OWASP ASVS L2, OWASP API Top 10, OWASP MAS, Stripe integration security guidance.

## Authorization model

- **Database**: RLS on every exposed table, default deny, explicit per-operation policies
  (matrix in `RLS_POLICY_MATRIX.md`). Client roles additionally have INSERT/UPDATE/DELETE
  **privileges revoked** on payment, billing, enrollment, entitlement, webhook and admin
  tables — a policy bug cannot re-open them.
- **services/api**: connects with privileged credentials, therefore every route does its own
  authorization: Supabase JWT (HS256, `role=authenticated`) for users; constant-time
  bearer-token comparison for cron jobs. Object-level checks run in SQL with the caller's id.
- **Column guards**: privileged columns (trainer approval, credential verification, review
  moderation, media publish state) are protected by triggers that allow changes only from
  service contexts (`app.is_service_context()`); PostgREST clients always carry JWT claims
  and can never satisfy it.

## Payment integrity

- Webhook signatures verified (300 s tolerance) before the body is even parsed.
- Event ids claimed in `webhook_events` (unique) **before** side effects → duplicates are
  no-ops; handlers are idempotent and out-of-order tolerant; failures are recorded for
  dead-letter reconciliation and Stripe retries.
- Orders/enrollments/entitlements change only in the webhook/jobs path. Redirect pages
  render database state.
- Integer minor units everywhere; append-only ledgers enforced by triggers; compensating
  entries instead of edits; deterministic idempotency keys on every Stripe mutation.

## Input handling

- Every boundary validates with shared Zod schemas (`@fitmarket/validation`); privileged
  inputs use `.strict()` (mass-assignment rejection). Parameterized queries only.
- React default escaping; no `dangerouslySetInnerHTML`; no user HTML anywhere.
- Uploads: magic-byte sniffing, declared-type match required, SVG rejected, dimension/pixel
  caps (image bombs), random object keys, quarantine before publish, signed short-lived
  URLs, per-user quotas.

## Web/edge controls

- CSP (`frame-ancestors 'none'`), HSTS, nosniff, Referrer-Policy, Permissions-Policy on
  web and API. Strict CORS allowlist on the API (bearer tokens, no cookies → no CSRF
  surface there). Web mutations use SameSite=Lax HttpOnly cookies + server actions.
- Open-redirect protection on every user-controlled redirect (`safeNextPath`, auth callback).
- Rate limiting: token buckets per IP and per user in the API (Cloudflare rules in front in
  production); tighter buckets on checkout; exponential backoff + Turnstile on abuse-prone
  auth flows (flag `turnstile_registration`).
- Enumeration-resistant auth responses; honeypot field on registration.

## Secrets

- Startup env validation fails closed. Server-only names never use NEXT_PUBLIC_/EXPO_PUBLIC_.
- CI: gitleaks + `pnpm audit` + a client-bundle scan that fails the build if service-role or
  Stripe secret markers appear in `apps/web/.next/static`.
- Mobile session tokens live in SecureStore (keychain/keystore), never AsyncStorage.

## Logging & privacy

- Only the redacting logger (`@fitmarket/observability`): passwords, tokens, cookies,
  authorization headers, message bodies, emails, exact addresses are censored by path.
- Correlation ids on every request; audit records (`audit_logs`, `admin_actions`,
  `media_access_logs`) are append-only.

## Reporting a vulnerability

See the root `SECURITY.md` for the disclosure policy.
