# ADR-0003: RLS default deny + privilege revocation on financial tables

Status: accepted · Date: 2026-07-12

## Context
RLS policies are powerful but a single over-broad policy can re-expose a table. Payment,
billing, enrollment and webhook tables must never be client-writable.

## Decision
Two layers: (1) RLS enabled on every table, default deny, explicit per-operation policies;
(2) for financial/state tables, additionally `REVOKE INSERT/UPDATE/DELETE` (or ALL) from
`anon`/`authenticated` — writes only via the privileged server. Column-level guards
(trigger + `app.is_service_context()`) protect privileged columns on mixed tables
(approval, moderation, media status). `is_service_context()` treats "no JWT claims" as
service context because PostgREST always injects claims while direct server connections
don't — clients cannot clear the GUC.

## Consequences
A policy regression cannot grant writes to money tables; tests assert `permission denied`
(not just zero rows). Slight duplication between grants and policies, documented in the
RLS matrix.
