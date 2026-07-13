-- 0006: orders, payments, append-only payment ledger, refunds, disputes,
-- transfers, payouts, idempotency records, webhook events.

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.users (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  program_id uuid not null references public.programs (id),
  purchase_snapshot_id uuid not null references public.program_purchase_snapshots (id),
  status public.order_status not null default 'created',
  amount_cents int not null check (amount_cents >= 0),
  platform_fee_cents int not null default 0 check (platform_fee_cents >= 0),
  currency char(3) not null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  idempotency_key text not null unique,
  expires_at timestamptz,
  paid_at timestamptz,
  canceled_at timestamptz,
  version int not null default 1, -- optimistic concurrency
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger orders_touch before update on public.orders
  for each row execute function app.touch_updated_at();

create index orders_client_idx on public.orders (client_id, created_at desc);
create index orders_trainer_idx on public.orders (trainer_id, created_at desc);
create index orders_status_idx on public.orders (status) where status in ('created', 'awaiting_payment');

create or replace function app.validate_order_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if (old.status = 'created' and new.status in ('awaiting_payment', 'canceled', 'expired', 'failed'))
     or (old.status = 'awaiting_payment' and new.status in ('paid', 'canceled', 'expired', 'failed'))
     or (old.status = 'failed' and new.status in ('awaiting_payment', 'canceled', 'expired'))
     or (old.status = 'paid' and new.status in ('refunded', 'partially_refunded'))
     or (old.status = 'partially_refunded' and new.status = 'refunded') then
    return new;
  end if;
  raise exception 'invalid order status transition % -> %', old.status, new.status;
end
$$;

create trigger orders_validate_transition
  before update on public.orders
  for each row execute function app.validate_order_transition();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  stripe_payment_intent_id text unique,
  stripe_charge_id text unique,
  status public.payment_status not null default 'processing',
  amount_cents int not null check (amount_cents >= 0),
  amount_refunded_cents int not null default 0 check (amount_refunded_cents >= 0),
  currency char(3) not null,
  stripe_fee_cents int,
  payment_method_brand text,
  payment_method_last4 char(4),
  failure_code text,
  failure_message text,
  succeeded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refund_not_exceeding check (amount_refunded_cents <= amount_cents)
);

create trigger payments_touch before update on public.payments
  for each row execute function app.touch_updated_at();

create index payments_order_idx on public.payments (order_id);

-- Append-only double-entry style internal ledger, separate from Stripe objects.
create table public.payment_ledger (
  id uuid primary key default gen_random_uuid(),
  entry_group_id uuid not null, -- entries created together (balanced group)
  account public.ledger_account not null,
  direction public.ledger_direction not null,
  amount_cents int not null check (amount_cents > 0),
  currency char(3) not null,
  order_id uuid references public.orders (id),
  payment_id uuid references public.payments (id),
  refund_id uuid,
  dispute_id uuid,
  transfer_id uuid,
  trainer_id uuid references public.trainer_profiles (user_id),
  client_id uuid references public.users (id),
  billing_ledger_id uuid references public.active_client_billing_ledger (id),
  description text not null check (char_length(description) <= 500),
  stripe_object_id text,
  idempotency_key text not null,
  created_by text not null default 'system' check (created_by in ('system', 'webhook', 'admin_adjustment', 'reconciliation')),
  admin_action_id uuid,
  created_at timestamptz not null default now(),
  unique (idempotency_key, account, direction)
);

create index payment_ledger_order_idx on public.payment_ledger (order_id);
create index payment_ledger_trainer_idx on public.payment_ledger (trainer_id, created_at desc);
create index payment_ledger_group_idx on public.payment_ledger (entry_group_id);

create trigger payment_ledger_immutable
  before update or delete on public.payment_ledger
  for each row execute function app.forbid_mutation();

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id),
  order_id uuid not null references public.orders (id),
  stripe_refund_id text unique,
  amount_cents int not null check (amount_cents > 0),
  currency char(3) not null,
  reason text check (char_length(reason) <= 500),
  status public.refund_status not null default 'pending',
  initiated_by uuid references public.users (id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger refunds_touch before update on public.refunds
  for each row execute function app.touch_updated_at();

create index refunds_order_idx on public.refunds (order_id);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id),
  order_id uuid not null references public.orders (id),
  stripe_dispute_id text not null unique,
  amount_cents int not null,
  currency char(3) not null,
  status public.dispute_status not null,
  reason text,
  evidence_due_by timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger disputes_touch before update on public.disputes
  for each row execute function app.touch_updated_at();

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  stripe_transfer_id text unique,
  stripe_destination_account text not null,
  amount_cents int not null check (amount_cents > 0),
  amount_reversed_cents int not null default 0 check (amount_reversed_cents >= 0),
  currency char(3) not null,
  status public.transfer_status not null default 'pending',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reversal_not_exceeding check (amount_reversed_cents <= amount_cents)
);

create trigger transfers_touch before update on public.transfers
  for each row execute function app.touch_updated_at();

create index transfers_trainer_idx on public.transfers (trainer_id, created_at desc);

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  stripe_payout_id text unique,
  amount_cents int not null,
  currency char(3) not null,
  status public.payout_status not null default 'pending',
  arrival_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger payouts_touch before update on public.payouts
  for each row execute function app.touch_updated_at();

create index payouts_trainer_idx on public.payouts (trainer_id, created_at desc);

-- Cross-cutting idempotency for privileged mutations.
create table public.idempotency_records (
  key text primary key,
  scope text not null check (char_length(scope) <= 100),
  request_hash text,
  response jsonb,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index idempotency_records_expiry_idx on public.idempotency_records (expires_at);

-- Webhook event dedupe + replay protection + dead-letter handling.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe')),
  event_id text not null,
  event_type text not null,
  api_version text,
  payload jsonb not null,
  status public.webhook_event_status not null default 'received',
  attempts int not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

create index webhook_events_status_idx on public.webhook_events (status, received_at)
  where status in ('received', 'failed');

-- ---------------------------------------------------------------------------
-- RLS: read-own; every write goes through the privileged server (service_role).
-- ---------------------------------------------------------------------------

alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.payment_ledger enable row level security;
alter table public.refunds enable row level security;
alter table public.disputes enable row level security;
alter table public.transfers enable row level security;
alter table public.payouts enable row level security;
alter table public.idempotency_records enable row level security;
alter table public.webhook_events enable row level security;

create policy orders_client_select on public.orders
  for select using (client_id = auth.uid());
create policy orders_trainer_select on public.orders
  for select using (trainer_id = auth.uid());

create policy payments_party_select on public.payments
  for select using (
    exists (select 1 from public.orders o
            where o.id = payments.order_id
              and (o.client_id = auth.uid() or o.trainer_id = auth.uid()))
  );

create policy payment_ledger_trainer_select on public.payment_ledger
  for select using (trainer_id = auth.uid());
create policy payment_ledger_client_select on public.payment_ledger
  for select using (client_id = auth.uid());

create policy refunds_party_select on public.refunds
  for select using (
    exists (select 1 from public.orders o
            where o.id = refunds.order_id
              and (o.client_id = auth.uid() or o.trainer_id = auth.uid()))
  );

create policy disputes_trainer_select on public.disputes
  for select using (
    exists (select 1 from public.orders o
            where o.id = disputes.order_id and o.trainer_id = auth.uid())
  );

create policy transfers_trainer_select on public.transfers
  for select using (trainer_id = auth.uid());
create policy payouts_trainer_select on public.payouts
  for select using (trainer_id = auth.uid());

-- idempotency_records / webhook_events: service-role only (no client policies).

revoke insert, update, delete on public.orders from anon, authenticated;
revoke insert, update, delete on public.payments from anon, authenticated;
revoke insert, update, delete on public.payment_ledger from anon, authenticated;
revoke insert, update, delete on public.refunds from anon, authenticated;
revoke insert, update, delete on public.disputes from anon, authenticated;
revoke insert, update, delete on public.transfers from anon, authenticated;
revoke insert, update, delete on public.payouts from anon, authenticated;
revoke all on public.idempotency_records from anon, authenticated;
revoke all on public.webhook_events from anon, authenticated;
