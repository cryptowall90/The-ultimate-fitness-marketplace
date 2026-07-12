# Architecture

Modular monolith on managed services: one PostgreSQL database (Supabase) with RLS as the
database-level authorization boundary, one privileged API service for payments/billing,
and two clients (Next.js web, Expo mobile) that talk to Supabase with the anon key and to
the privileged API with user bearer tokens.

## System context

```mermaid
C4Context
  Person(client, "Client", "Buys programs, messages trainer, reviews")
  Person(trainer, "Trainer", "Runs CRM, gets paid")
  Person(admin, "Admin/Moderator", "Approves trainers, moderates")
  System(fitmarket, "FitMarket", "Marketplace + CRM")
  System_Ext(stripe, "Stripe", "Payments, Connect payouts, Billing")
  System_Ext(supabase, "Supabase", "Postgres, Auth, Storage, Realtime")
  System_Ext(cf, "Cloudflare", "DNS, CDN, WAF, Turnstile, Images")
  Rel(client, fitmarket, "Uses")
  Rel(trainer, fitmarket, "Uses")
  Rel(admin, fitmarket, "Operates")
  Rel(fitmarket, stripe, "Checkout, webhooks, transfers")
  Rel(fitmarket, supabase, "SQL + Auth + Storage")
  Rel(fitmarket, cf, "Edge protection + media")
```

## Containers

```mermaid
flowchart LR
  subgraph Clients
    WEB[apps/web Next.js]
    MOB[apps/mobile Expo]
  end
  subgraph Data["Supabase"]
    PG[(PostgreSQL + PostGIS + RLS)]
    AUTH[Supabase Auth]
    STORE[(Private Storage)]
  end
  API[services/api Hono - privileged]
  STRIPE[Stripe]
  CF[Cloudflare edge]

  WEB -- anon key + user JWT / RLS --> PG
  MOB -- anon key + user JWT / RLS --> PG
  WEB & MOB -- bearer JWT --> API
  API -- privileged SQL --> PG
  API <-- signed webhooks --> STRIPE
  WEB & MOB --- AUTH
  CF --- WEB
  CF --- API
```

Key decisions (full text in `docs/adr/`):

| ADR | Decision |
| --- | --- |
| 0001 | pnpm workspaces, no extra task runner until needed |
| 0002 | Plain-SQL forward-only migrations with our own runner + local Supabase shim |
| 0003 | RLS default deny + revoked client write privileges on financial tables |
| 0004 | Stripe Connect destination charges; policy-driven commission (default 0) |
| 0005 | Active-client billing via invoice items + append-only ledger |
| 0006 | services/api (Hono) instead of edge functions for payment paths |

## Authentication flow

```mermaid
sequenceDiagram
  participant U as User
  participant W as apps/web
  participant SA as Supabase Auth
  participant DB as Postgres (RLS)
  U->>W: sign up (email/password + terms + honeypot)
  W->>SA: auth.signUp (PKCE)
  SA-->>U: verification email
  U->>W: /auth/callback?code=...
  W->>SA: exchangeCodeForSession
  SA-->>W: session cookies (HttpOnly, SameSite=Lax)
  Note over SA,DB: on_auth_user_created trigger provisions users/profiles/roles
  W->>DB: queries as authenticated (RLS applies)
```

## Client checkout & payout

```mermaid
sequenceDiagram
  participant C as Client
  participant W as Web/Mobile
  participant A as services/api
  participant S as Stripe
  participant DB as Postgres
  C->>W: Buy program
  W->>A: POST /v1/checkout/programs {programId} + JWT
  A->>DB: load published program + policy (price from DB)
  A->>DB: insert snapshot + order (awaiting_payment)
  A->>S: create Checkout Session (destination charge, idempotency key)
  A-->>W: checkout URL
  C->>S: pays
  S-->>A: checkout.session.completed (signed)
  A->>DB: claim event id, order->paid, enrollment+entitlements+conversation, ledger
  Note over W: redirect page only reflects DB state - never grants access
  S->>S: funds routed to trainer connected account (minus policy fee)
```

## Enrollment state machine

```mermaid
stateDiagram-v2
  [*] --> pending_payment
  pending_payment --> active: webhook verified
  pending_payment --> pending_acceptance: manual approval programs
  pending_acceptance --> active
  pending_payment --> expired: checkout expired
  active --> paused
  paused --> active
  active --> completed
  active --> expired: access window passed
  active --> canceled
  active --> refunded
  active --> terminated: moderation
  completed --> refunded
  expired --> refunded
```

Enforced in TypeScript (`@fitmarket/domain`) **and** by a database trigger.

## Geographic search

City text → server-side geocoding adapter → `app.search_trainers_nearby(lat, lng, radius)`
(SECURITY DEFINER SQL, GIST index, radius hard-capped at 160 km, page size ≤ 50, keyset
pagination on (distance, id)). Only coarse public points and area labels leave the
database; exact locations are owner-only rows.

## Trainer billing

See `docs/BILLING.md`. Subscription via Stripe Billing; the $2.50 active-client fee is
computed by a locked, idempotent job into `active_client_billing_ledger` (unique per
enrollment × period) and pushed as Stripe invoice items with deterministic idempotency keys.

## Messaging authorization

```mermaid
flowchart TD
  M[INSERT message] --> P{participant?}
  P -- no --> D[deny]
  P -- yes --> S{sender = auth.uid?}
  S -- no --> D
  S -- yes --> CS{conversation active?}
  CS -- no --> D
  CS -- yes --> B{blocked?}
  B -- yes --> D
  B -- no --> E{messaging entitlement active + in window?}
  E -- no --> D
  E -- yes --> OK[allow]
```

All checks run inside RLS policies/functions — the client cannot bypass them.

## Media upload

```mermaid
sequenceDiagram
  participant M as Mobile/Web
  participant A as services/api
  participant ST as Storage provider
  M->>M: resize, strip EXIF/GPS, compress (targets in @fitmarket/media)
  M->>A: request signed upload (auth + quota check)
  A->>A: random object key, size cap, content-type pin
  A-->>M: one-time signed URL (short expiry)
  M->>ST: PUT bytes
  A->>ST: fetch head/bytes, magic-byte sniff, dimension caps
  A->>A: quarantine -> re-encode -> variants -> published
  Note over A: private media served only via short-lived signed URLs + audit log
```

## Account deletion

Request → soft-mark → grace window → purge job anonymizes PII, deletes media, retains
financial records with redaction (legal basis documented in `docs/PRIVACY.md`), honors
legal holds.
