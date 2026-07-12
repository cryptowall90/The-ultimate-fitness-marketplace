# ADR-0006: services/api on Hono (Node) rather than edge functions

Status: accepted · Date: 2026-07-12

## Context
Privileged operations (webhooks, checkout, billing jobs) need: raw-body signature
verification, long-lived Postgres connections/transactions, Stripe SDK, and testability.
Supabase Edge Functions (Deno) complicate the pg driver, local testing and the Stripe SDK
surface; cold starts hurt webhook latency.

## Decision
A single small Hono app on Node 22 (`services/api`), deployable to any container host with
scale-to-zero. All dependencies injected (`buildApp(deps)`) so integration tests run the
real app against a real database with fake gateways.

## Consequences
One always-deployable artifact, first-class transactions and tests; costs a small container
(~$5/mo) versus per-invocation functions. The app is stateless, so horizontal scaling only
requires swapping the in-memory rate limiter for the durable implementation (interface in
place).
