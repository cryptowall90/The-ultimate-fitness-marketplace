# ADR-0005: Active-client billing via invoice items + append-only ledger

Status: accepted · Date: 2026-07-12

## Context
The $2.50/active-client charge must be exact, auditable, idempotent, and independent of
Stripe's metering quirks. Stripe options: usage-based metering (async aggregation, harder
to audit per-client) vs. invoice items attached to the subscription's next invoice.

## Decision
Our database is the source of truth: an idempotent job computes billable enrollments
(domain rules in `@fitmarket/domain`), writes `active_client_billing_ledger` rows guarded
by a unique (enrollment_id, period_start) index, then creates one Stripe invoice item per
row using the row's deterministic idempotency key. `invoice.paid` finalizes rows.

## Consequences
Per-client line items are individually traceable ledger rows; double-billing is impossible
at three layers (domain dedupe, DB unique index, Stripe idempotency). If Stripe's metered
billing becomes preferable, only the `SubscriptionGateway` implementation changes.
