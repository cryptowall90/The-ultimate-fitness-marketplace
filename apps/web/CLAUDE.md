# apps/web — instructions

These rules extend the root CLAUDE.md; they never weaken it.

- The browser gets the anon key only. RLS is the authorization boundary for every
  supabase-js query; route guards and middleware are UX, not security.
- Never reference a server-only env var in client components; public config goes through
  `src/lib/env.ts` (NEXT_PUBLIC_*, validated). The service-role key must never appear in
  this app — privileged work belongs to services/api.
- Payments: the buy button only requests a checkout URL from services/api with the
  program id. Prices are never sent from the browser; purchase success is only what
  `orders.status` says after the webhook (see /purchases/[orderId]). No optimistic
  payment success.
- Render user content with React escaping only. No `dangerouslySetInnerHTML`.
- Redirect targets from query params must be same-origin relative paths (see
  `safeNextPath` / auth callback). Keep it that way for any new redirect.
- Auth error messages stay uniform (enumeration-resistant).
- Security headers live in next.config.ts; the CSP (per-request script nonce +
  'strict-dynamic', no 'unsafe-inline' for scripts) is minted in src/middleware.ts.
  Changes to either require a security review.
- Forms: shared Zod schemas from @fitmarket/validation on every boundary (server actions
  re-validate even when the client validated).
