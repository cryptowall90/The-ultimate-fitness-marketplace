# Payments

## Model

Stripe Connect **destination charges** (ADR-0004): the platform creates the Checkout
Session; funds route to the trainer's Express connected account via
`payment_intent_data.transfer_data.destination`. An `application_fee_amount` is attached
only when `trainer_billing_policy.transaction_commission_bps > 0` (default **0**; admins can
enable later without schema changes — the fee column, ledger account and policy row already
exist).

## Flow of record

1. `POST /v1/checkout/programs` (JWT): server loads the **published** program + latest
   version, snapshots it (`program_purchase_snapshots`, immutable), inserts an order
   (`created → awaiting_payment`), creates the Checkout Session with a deterministic
   idempotency key. Client only ever sends the program id.
2. Stripe webhook `checkout.session.completed` (signature verified, event id claimed):
   order `→ paid`, payments row, enrollment (`pending_payment → active` under the DB state
   machine), entitlements (content/messaging/review) bounded by the snapshot duration,
   conversation + participants, CRM record, and balanced `payment_ledger` entries.
3. The success redirect page (`/purchases/[orderId]`) **only reads** order state.

## Refunds, disputes, reversals

- `charge.refunded`: monotonic guard on `amount_refunded`, payments/orders transition to
  `partially_refunded`/`refunded`; full refunds revoke entitlements and move the enrollment
  to `refunded` (state-machine validated); `refunds` rows keyed by `stripe_refund_id`;
  ledger debit entries with idempotency keys. Refund creation uses `reverse_transfer` so the
  trainer's share is pulled back (negative-balance handling per Stripe).
- `charge.dispute.*`: upserted into `disputes` by `stripe_dispute_id` with evidence
  deadlines; funds movement recorded on resolution via ledger entries.

## Ledger

`payment_ledger` is double-entry-ish and append-only (trigger blocks UPDATE/DELETE):
each business event writes a balanced entry group (`entry_group_id`), unique on
(idempotency_key, account, direction). Admin corrections are compensating entries linked to
an `admin_actions` row — never edits.

## Reconciliation

A scheduled job (runbook: `INCIDENT_RESPONSE.md`) lists Stripe balance transactions per day
and compares against `payments`/`refunds`/`transfers` sums; mismatches above
`system_settings.billing.reconciliation_alert_threshold_cents` alert. `webhook_events` rows
in `failed`/`received` older than 15 min feed the dead-letter re-processor; missing-webhook
recovery re-fetches recent events from Stripe's events API.

## Invariants (tested)

- No enrollment/entitlement without a verified webhook (integration test).
- Duplicate or re-emitted webhooks never duplicate enrollments, ledger rows or invoice items.
- Clients cannot write payment state at all (`permission denied`, RLS tests).
- Amounts always integer cents + currency; no floats anywhere in money paths.
