# Contributing

1. Read `CLAUDE.md` (root) — the non-negotiable rules — plus the nested CLAUDE.md of any
   directory you touch.
2. Node ≥ 22, pnpm 10. `pnpm install`, start the dev DB
   (`packages/database/scripts/dev-db.sh start`), `pnpm db:reset && pnpm db:seed`.
3. Every change lands with: shared-Zod validation on new inputs, RLS + tests for new
   tables, success/failure/unauthorized test coverage, updated docs, and an updated
   `docs/IMPLEMENTATION_STATUS.md`.
4. Before pushing: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit`,
   plus `pnpm test:db` / `pnpm test:api` when the database or API changed, plus
   `pnpm --filter @fitmarket/web build` for web changes.
5. New dependency? Justify it in the PR description or an ADR (why existing deps are
   insufficient). Pin the version.
6. Never commit secrets — `.env.example` holds names only; CI runs gitleaks and a client
   bundle scan.
7. Migrations are forward-only; never edit an applied one. Financial tables stay
   append-only.
8. Architecture decisions go in `docs/adr/NNNN-*.md`.
