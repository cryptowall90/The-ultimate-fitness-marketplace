# Threat model

Method: STRIDE per trust boundary. Assets ranked: (1) payment integrity, (2) private
client fitness data, (3) trainer PII/addresses, (4) account credentials, (5) availability.

## Trust boundaries

1. Browser/mobile ↔ Supabase (anon key + user JWT, RLS boundary)
2. Browser/mobile ↔ services/api (bearer JWT)
3. Stripe ↔ services/api (webhook signatures)
4. services/api ↔ Postgres (privileged connection)
5. Admin/moderator ↔ platform (privileged UI paths)

## Key threats and mitigations

| Threat | Vector | Mitigation |
| --- | --- | --- |
| Fake payment success | Forged redirect/callback, replayed webhook | Access granted only in verified-webhook path; signature + timestamp tolerance; event-id dedupe; order state machine |
| Double billing | Job re-runs, races, duplicate webhooks | Unique (enrollment, period) index; deterministic idempotency keys; job lock; domain dedupe |
| Cross-tenant read (BOLA) | Tampered ids in queries | RLS default deny keyed on `auth.uid()`; tests attempt every documented cross-tenant read/write |
| Privilege escalation | Self-granted roles, self-approval | `user_roles` writes are service-only; approval columns trigger-guarded; `is_service_context()` unreachable from PostgREST |
| Trainer address leak | Search responses, profile scraping | Exact location owner-only; search via definer functions returning safe columns; test asserts absence |
| Private photo leak | URL guessing, unrelated trainer access | Private buckets, signed short-lived URLs, RLS on metadata, sharing flag, access audit |
| Message spoofing | Client-set sender id | Policy requires `sender_id = auth.uid()` + participant + entitlement |
| Review manipulation | Fake reviews, trainer edits, rating floods | Enrollment-gated inserts, one per enrollment (unique), trainer response-only trigger, Bayesian aggregate recomputed server-side, rate limits |
| Credential stuffing / brute force | Auth endpoints | Supabase Auth throttling + our rate buckets + Turnstile flag + uniform errors |
| Webhook forgery | Fake Stripe posts | Signature verification before parse; secret only in services/api |
| Mass assignment | Extra JSON fields | `.strict()` Zod schemas on privileged inputs |
| SSRF | Geocoding/outbound fetches | Server-side adapter with allowlist (launch build ships a static city table; the adapter contract requires allowlisted hosts + no redirects) |
| Image bombs / polyglots | Upload pipeline | Magic-byte + declared-type match, dimension/pixel caps, re-encode before publish, SVG banned |
| Expensive geo queries (DoS) | Huge radius/limit | SQL-side clamps (160 km, 50 rows) regardless of caller |
| Secret leakage | Bundles, logs, repo | Bundle scan in CI, redacting logger, gitleaks, env validation |
| Admin account takeover | Phished admin | MFA enforcement flag, reauth for high-risk actions, immutable `admin_actions` with reason, second-approver column |

## Accepted residual risks (tracked)

- In-memory rate limiting is per-instance; multi-instance deployments need the durable
  limiter (interface already in place) — mitigated by Cloudflare rules at the edge.
- Launch geocoding uses a static city table; the external geocoder adapter must go through
  the SSRF-hardened egress path when added.
- Next.js CSP still allows 'unsafe-inline' scripts pending nonce wiring (hardening phase).
