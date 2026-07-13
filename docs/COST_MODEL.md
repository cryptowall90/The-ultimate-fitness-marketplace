# Cost model

> Prices below are **configurable estimates, not quotes**. Verify against provider pricing
> pages before budgeting. Estimate verification date: **2026-07-12** (values entered as
> planning placeholders; re-verify at launch).

## Fixed monthly services (launch scale)

| Service | Plan assumption | Est. $/mo |
| --- | --- | --- |
| Supabase | Pro (db, auth, storage, realtime) | 25 |
| services/api hosting | 1 small container (Fly/Railway/Render, scale-to-zero capable) | 5–10 |
| Vercel (web) | Hobby→Pro when commercial | 0–20 |
| Cloudflare | Free WAF/CDN/Turnstile; Images on usage | 0–5 |
| Sentry | Developer tier, sampled | 0 |
| Resend/Postmark | Starter volume | 0–15 |
| PostHog | Free tier, sampled events | 0 |
| **Total fixed** | | **~35–75** |

## Variable cost drivers

- **Stripe fees** (dominant): ~2.9% + $0.30 per charge, Connect payout costs, Billing fee
  on subscription volume — margin math, not infra.
- **Images**: assume 3 photos/active client/mo @ ~400 KB stored + variants; delivery via
  CDN cache (high hit ratio); Cloudflare Images ~$5/100k stored, $1/100k delivered.
- **Database growth**: messages dominate rows (~2 KB/row); 10k MAU ≈ low GB/yr — within
  plan storage for a long time.
- **Realtime**: bounded subscriptions (per open conversation), sampled presence — free-tier
  connection counts until ~10k MAU.
- **Email/push**: transactional-only by default; digests batched.
- **Logs/monitoring**: security audit logs kept (DB), app logs sampled + archived to R2.

## Cost per active-user scale (infra only, rough)

| MAU | Assumption | Est. $/mo |
| --- | --- | --- |
| 100 | free/base tiers | 35–75 |
| 1,000 | Supabase Pro headroom, small API instance | 75–150 |
| 10,000 | 2× API instances, image volume, email volume | 300–700 |
| 100,000 | dedicated Postgres tier, read replica, queue worker, CDN paid tier | 3,000–8,000 |

## Cost-reduction levers

Client-side image compression (already required), CDN caching of public search/profiles,
sampled telemetry, lifecycle deletion of abandoned uploads, digest notifications, keeping
the modular monolith (no per-service overhead).

## Upgrade triggers

- DB CPU p95 > 60% sustained or storage > 70% of plan → next Supabase tier.
- API p95 > 300 ms at steady state → second instance + durable rate limiter.
- Webhook backlog > 1 min consistently → dedicated worker process.
- Realtime connections near plan cap → move chat polling fallback / dedicated channel plan.
