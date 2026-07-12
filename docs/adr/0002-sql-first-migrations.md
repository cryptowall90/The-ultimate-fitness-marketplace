# ADR-0002: Plain-SQL forward-only migrations with an in-repo runner

Status: accepted · Date: 2026-07-12

## Context
Supabase CLI migrations require the CLI/docker locally; ORMs (Prisma/Drizzle) generate
schema but obscure RLS, triggers, PostGIS and grants — the parts that carry our security
model.

## Decision
Ordered plain SQL in `packages/database/migrations`, applied transactionally by a ~100-line
runner (`pg`), recorded in a locked `schema_migrations` table. A local shim
(`migrations-local/0000_supabase_shim.sql`) emulates Supabase (auth schema, `auth.uid()`,
anon/authenticated/service_role) ONLY when the `auth` schema is absent, so the same
migrations run on plain Postgres in dev/CI and on Supabase in production.

## Consequences
RLS/policies/triggers are first-class and reviewable; tests run against the real engine
(PG16 + PostGIS). We forgo ORM type generation — DB types come from `supabase gen types`
(documented) and shared enums are mirrored in `@fitmarket/types`.
