# services/api — instructions

These rules extend the root CLAUDE.md; they never weaken it.

- This is the ONLY place that talks to Stripe or writes payment/enrollment/billing tables.
  It connects with privileged database credentials; every route must therefore do its own
  authorization (bearer JWT for users, constant-time job token for cron) — RLS does not
  protect direct connections.
- Webhooks: verify signature first, claim the event id in `webhook_events` before any
  side effect, keep handlers idempotent and out-of-order tolerant. Return 500 on handler
  failure so Stripe retries; the failed row feeds dead-letter reconciliation.
- Checkout amounts and fees are read from the database (program version + billing policy),
  never from request bodies. `createCheckoutSchema` is `.strict()` — keep it that way.
- Access is granted only in the webhook path. No route may activate an enrollment from a
  redirect or client-supplied "payment succeeded" signal.
- All request validation uses @fitmarket/validation. All logging uses the redacting logger
  with the request correlation id.
- Tests run against a real Postgres with fake gateways (`test/fakes.ts`). Every new route
  needs success, failure, and unauthorized tests.
