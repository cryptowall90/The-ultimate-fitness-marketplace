# packages/payments — instructions

These rules extend the root CLAUDE.md; they never weaken it.

- Call sites depend on the interfaces in `src/interfaces.ts`, never on the Stripe SDK
  directly. Tests use fakes of those interfaces.
- Connect model is destination charges (ADR-0004). The application fee comes from
  `trainer_billing_policy.transaction_commission_bps` (default 0) — never hardcode.
- Every Stripe mutation passes an `idempotencyKey` derived deterministically from the
  domain operation (see `billingIdempotencyKey` in @fitmarket/domain).
- Webhook verification uses `stripe.webhooks.constructEvent` with a 300 s timestamp
  tolerance. Never parse a webhook body before verification succeeds.
- Amounts are integer minor units end to end. No floats, no `parseFloat`, no arithmetic
  on formatted strings.
- The Stripe API version is pinned in `src/stripe.ts`; bumping it requires re-running the
  webhook fixture tests and updating docs/PAYMENTS.md.
