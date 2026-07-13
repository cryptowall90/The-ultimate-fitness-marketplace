-- 0004: trainer platform billing — Stripe customer/connected accounts, the
-- $34.99 subscription, billing policy, and the append-only active-client ledger.

create table public.stripe_connected_accounts (
  trainer_id uuid primary key references public.trainer_profiles (user_id) on delete cascade,
  stripe_account_id text not null unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  details_submitted boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  disabled_reason text,
  requirements_due jsonb not null default '[]'::jsonb, -- Stripe payload snapshot
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger stripe_connected_accounts_touch before update on public.stripe_connected_accounts
  for each row execute function app.touch_updated_at();

create table public.trainer_subscription_accounts (
  trainer_id uuid primary key references public.trainer_profiles (user_id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id text unique check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  status public.subscription_status not null default 'incomplete',
  cancel_at_period_end boolean not null default false,
  grace_period_ends_at timestamptz,
  suspended_at timestamptz,
  delinquent_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trainer_subscription_accounts_touch before update on public.trainer_subscription_accounts
  for each row execute function app.touch_updated_at();

create index tsa_status_idx on public.trainer_subscription_accounts (status);

-- One row per Stripe billing period; the anchor for active-client billing.
create table public.trainer_subscription_periods (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_subscription_accounts (trainer_id) on delete cascade,
  stripe_invoice_id text unique,
  period_start timestamptz not null,
  period_end timestamptz not null,
  base_amount_cents int not null check (base_amount_cents >= 0),
  currency char(3) not null default 'usd',
  status text not null default 'open' check (status in ('open', 'invoiced', 'paid', 'past_due', 'voided')),
  active_client_count int,
  active_client_fee_cents int check (active_client_fee_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint period_valid check (period_end > period_start),
  unique (trainer_id, period_start)
);

create trigger trainer_subscription_periods_touch before update on public.trainer_subscription_periods
  for each row execute function app.touch_updated_at();

-- Admin-configurable billing policy. Policy values are NEVER hardcoded in
-- client code. A new row supersedes the old one (history preserved).
create table public.trainer_billing_policy (
  id uuid primary key default gen_random_uuid(),
  platform_subscription_cents int not null check (platform_subscription_cents >= 0),
  active_client_fee_cents int not null check (active_client_fee_cents >= 0),
  -- transaction commission on client purchases, basis points; 0 = disabled.
  transaction_commission_bps int not null default 0 check (transaction_commission_bps between 0 and 5000),
  currency char(3) not null default 'usd',
  trial_days int not null default 0 check (trial_days between 0 and 90),
  grace_period_days int not null default 7 check (grace_period_days between 0 and 60),
  effective_at timestamptz not null default now(),
  created_by uuid references public.users (id),
  note text,
  created_at timestamptz not null default now()
);

create index trainer_billing_policy_effective_idx on public.trainer_billing_policy (effective_at desc);

-- Append-only ledger of per-client charges. One row per (enrollment, trainer
-- billing period). UPDATE is limited to controlled status transitions; DELETE
-- is forbidden.
create table public.active_client_billing_ledger (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  client_id uuid not null references public.users (id),
  enrollment_id uuid not null, -- fk added in 0007 after enrollments exists
  trainer_billing_period_start timestamptz not null,
  trainer_billing_period_end timestamptz not null,
  amount_cents int not null check (amount_cents >= 0),
  currency char(3) not null default 'usd',
  status public.billing_ledger_status not null default 'pending',
  stripe_customer_id text,
  stripe_invoice_id text,
  stripe_invoice_item_id text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  constraint billing_period_valid check (trainer_billing_period_end > trainer_billing_period_start)
);

-- THE core billing-integrity constraint: an enrollment is billed at most once
-- per trainer billing period.
create unique index acbl_once_per_period
  on public.active_client_billing_ledger (enrollment_id, trainer_billing_period_start);

create index acbl_trainer_period_idx
  on public.active_client_billing_ledger (trainer_id, trainer_billing_period_start);
create index acbl_status_idx on public.active_client_billing_ledger (status)
  where status in ('pending', 'invoiced');

create or replace function app.protect_billing_ledger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'active_client_billing_ledger is append-only';
  end if;
  -- Only controlled transitions; identity/amount columns are immutable.
  if new.id is distinct from old.id
     or new.trainer_id is distinct from old.trainer_id
     or new.client_id is distinct from old.client_id
     or new.enrollment_id is distinct from old.enrollment_id
     or new.trainer_billing_period_start is distinct from old.trainer_billing_period_start
     or new.trainer_billing_period_end is distinct from old.trainer_billing_period_end
     or new.amount_cents is distinct from old.amount_cents
     or new.currency is distinct from old.currency
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'billing ledger identity columns are immutable';
  end if;
  if old.status = 'pending' and new.status in ('invoiced', 'voided') then
    return new;
  elsif old.status = 'invoiced' and new.status in ('finalized', 'voided') then
    return new;
  elsif old.status = new.status then
    return new; -- allow stripe id backfill during processing
  end if;
  raise exception 'invalid billing ledger status transition % -> %', old.status, new.status;
end
$$;

create trigger acbl_protect
  before update or delete on public.active_client_billing_ledger
  for each row execute function app.protect_billing_ledger();

-- ---------------------------------------------------------------------------
-- RLS: trainers read their own billing; ALL writes are service-role only.
-- Defense in depth: revoke write privileges from client roles entirely.
-- ---------------------------------------------------------------------------

alter table public.stripe_connected_accounts enable row level security;
alter table public.trainer_subscription_accounts enable row level security;
alter table public.trainer_subscription_periods enable row level security;
alter table public.trainer_billing_policy enable row level security;
alter table public.active_client_billing_ledger enable row level security;

create policy sca_owner_select on public.stripe_connected_accounts
  for select using (trainer_id = auth.uid());
create policy tsa_owner_select on public.trainer_subscription_accounts
  for select using (trainer_id = auth.uid());
create policy tsp_owner_select on public.trainer_subscription_periods
  for select using (trainer_id = auth.uid());
create policy tbp_select_authenticated on public.trainer_billing_policy
  for select using (auth.uid() is not null);
create policy acbl_owner_select on public.active_client_billing_ledger
  for select using (trainer_id = auth.uid());

revoke insert, update, delete on public.stripe_connected_accounts from anon, authenticated;
revoke insert, update, delete on public.trainer_subscription_accounts from anon, authenticated;
revoke insert, update, delete on public.trainer_subscription_periods from anon, authenticated;
revoke insert, update, delete on public.trainer_billing_policy from anon, authenticated;
revoke insert, update, delete on public.active_client_billing_ledger from anon, authenticated;
