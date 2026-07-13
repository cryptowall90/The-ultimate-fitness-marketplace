-- 0014: durable token buckets for services/api rate limiting. Multi-instance
-- safe: state lives here instead of process memory (Phase 9 hardening).
-- Written exclusively by the privileged server; clients have no access at all.

create table public.rate_limit_buckets (
  key text primary key check (char_length(key) <= 200),
  tokens numeric(12, 4) not null,
  updated_at timestamptz not null default now()
);

-- Stale buckets are pruned by the reconciliation job.
create index rate_limit_buckets_stale_idx on public.rate_limit_buckets (updated_at);

alter table public.rate_limit_buckets enable row level security;
-- Default deny: no policies on purpose — service-role connections bypass RLS.
revoke all on public.rate_limit_buckets from anon, authenticated;
