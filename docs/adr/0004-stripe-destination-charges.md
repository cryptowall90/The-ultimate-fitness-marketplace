# ADR-0004: Stripe Connect destination charges with policy-driven commission

Status: accepted · Date: 2026-07-12

## Context
Connect offers direct charges, destination charges, and separate charges & transfers. We
need: platform-controlled checkout, trainer payouts, refund/dispute handling, and the
ability to add a platform commission later without rework.

## Decision
Destination charges: platform creates the Checkout Session, funds route to the trainer's
Express account (`transfer_data.destination`), refunds use `reverse_transfer`. The
commission is `application_fee_amount`, computed from
`trainer_billing_policy.transaction_commission_bps` (default 0, admin-configurable). The
fee column, ledger account and policy row exist from day one, so enabling a commission is a
policy update, not a migration.

## Consequences
Platform is merchant of record (dispute liability on the platform account — mitigated by
`reverse_transfer` and negative-balance handling). Simpler than separate transfers; if we
later need multi-party splits we can move to separate charges & transfers behind the same
`PaymentGateway` interface.
