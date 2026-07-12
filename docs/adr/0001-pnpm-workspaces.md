# ADR-0001: pnpm workspaces without an extra task runner

Status: accepted · Date: 2026-07-12

## Context
The monorepo needs a package manager and task orchestration. Turborepo/Nx add caching and
graphs but also configuration surface and a dependency.

## Decision
pnpm workspaces with recursive scripts (`pnpm -r`, `--filter`). Versions pinned
(`save-exact`), lockfile committed, `engine-strict`.

## Consequences
Zero extra tooling to audit; CI caches via pnpm store. If build times grow past ~5 min we
revisit Turborepo — script layout is already compatible.
