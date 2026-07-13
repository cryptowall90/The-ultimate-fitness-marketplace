-- 0007: enrollments (state machine), status history, entitlements, and the
-- relationship helpers used across RLS.

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.users (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  program_id uuid not null references public.programs (id),
  purchase_snapshot_id uuid not null references public.program_purchase_snapshots (id),
  order_id uuid references public.orders (id),
  status public.enrollment_status not null default 'pending_payment',
  requested_start_at timestamptz,
  actual_start_at timestamptz,
  access_ends_at timestamptz,
  recurrence_interval public.duration_unit,
  recurrence_interval_count int,
  cancellation_requested_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  paused_at timestamptz,
  expired_at timestamptz,
  canceled_at timestamptz,
  refunded_at timestamptz,
  terminated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint distinct_parties check (client_id <> trainer_id)
);

create trigger enrollments_touch before update on public.enrollments
  for each row execute function app.touch_updated_at();

create index enrollments_client_idx on public.enrollments (client_id, status);
create index enrollments_trainer_idx on public.enrollments (trainer_id, status);
create index enrollments_program_idx on public.enrollments (program_id);
create index enrollments_order_idx on public.enrollments (order_id);
-- Billing scan: active enrollments overlapping a period.
create index enrollments_billing_scan_idx
  on public.enrollments (trainer_id, actual_start_at, access_ends_at)
  where status in ('active', 'paused', 'completed', 'expired');

-- Wire deferred FK from 0004.
alter table public.active_client_billing_ledger
  add constraint acbl_enrollment_fk
  foreign key (enrollment_id) references public.enrollments (id);

-- Enrollment state machine.
create or replace function app.validate_enrollment_transition() returns trigger
language plpgsql as $$
declare
  ok boolean := false;
begin
  if new.status = old.status then return new; end if;
  ok := case old.status
    when 'pending_payment'    then new.status in ('pending_acceptance', 'scheduled', 'active', 'canceled', 'expired')
    when 'pending_acceptance' then new.status in ('scheduled', 'active', 'canceled', 'refunded')
    when 'scheduled'          then new.status in ('active', 'canceled', 'refunded')
    when 'active'             then new.status in ('paused', 'completed', 'expired', 'canceled', 'refunded', 'terminated')
    when 'paused'             then new.status in ('active', 'completed', 'expired', 'canceled', 'refunded', 'terminated')
    when 'completed'          then new.status in ('refunded')
    when 'expired'            then new.status in ('refunded')
    else false
  end;
  if not ok then
    raise exception 'invalid enrollment status transition % -> %', old.status, new.status;
  end if;
  case new.status
    when 'active'     then new.activated_at := coalesce(new.activated_at, now());
    when 'paused'     then new.paused_at := now();
    when 'expired'    then new.expired_at := coalesce(new.expired_at, now());
    when 'canceled'   then new.canceled_at := coalesce(new.canceled_at, now());
    when 'refunded'   then new.refunded_at := coalesce(new.refunded_at, now());
    when 'terminated' then new.terminated_at := coalesce(new.terminated_at, now());
    else null;
  end case;
  return new;
end
$$;

create trigger enrollments_validate_transition
  before update on public.enrollments
  for each row execute function app.validate_enrollment_transition();

create table public.enrollment_status_history (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id) on delete cascade,
  from_status public.enrollment_status,
  to_status public.enrollment_status not null,
  changed_by uuid references public.users (id),
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

create index esh_enrollment_idx on public.enrollment_status_history (enrollment_id, created_at);

create or replace function app.record_enrollment_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.enrollment_status_history (enrollment_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, auth.uid());
  elsif new.status is distinct from old.status then
    insert into public.enrollment_status_history (enrollment_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
  end if;
  return new;
end
$$;

create trigger enrollments_record_history
  after insert or update on public.enrollments
  for each row execute function app.record_enrollment_history();

-- Entitlements: what an enrollment currently grants.
create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id) on delete cascade,
  client_id uuid not null references public.users (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  type public.entitlement_type not null,
  status public.entitlement_status not null default 'active',
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, type)
);

create trigger entitlements_touch before update on public.entitlements
  for each row execute function app.touch_updated_at();

create index entitlements_client_idx on public.entitlements (client_id, type, status);
create index entitlements_trainer_idx on public.entitlements (trainer_id, type, status);

-- ---------------------------------------------------------------------------
-- Relationship helpers used by RLS across the schema.
-- ---------------------------------------------------------------------------

-- Entitlement check honoring time bounds; authoritative for content/messaging/review gates.
create or replace function app.has_entitlement(
  p_client uuid, p_trainer uuid, p_type public.entitlement_type
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.entitlements e
    where e.client_id = p_client
      and e.trainer_id = p_trainer
      and e.type = p_type
      and e.status = 'active'
      and e.starts_at <= now()
      and (e.ends_at is null or e.ends_at > now())
  )
$$;

-- A trainer-client working relationship exists (any non-failed enrollment).
create or replace function app.trainer_client_relationship(
  p_trainer uuid, p_client uuid
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.enrollments en
    where en.trainer_id = p_trainer
      and en.client_id = p_client
      and en.status in ('pending_acceptance', 'scheduled', 'active', 'paused', 'completed', 'expired')
  )
$$;

create or replace function app.is_trainer_of(p_client uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.trainer_client_relationship(auth.uid(), p_client)
$$;

-- Now that relationships exist: trainers may read the client profile of their clients.
create policy client_profiles_trainer_select on public.client_profiles
  for select using (app.is_trainer_of(user_id));

create policy profiles_trainer_client_select on public.profiles
  for select using (
    app.is_trainer_of(user_id)
    or app.trainer_client_relationship(user_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- RLS for enrollment tables.
-- ---------------------------------------------------------------------------

alter table public.enrollments enable row level security;
alter table public.enrollment_status_history enable row level security;
alter table public.entitlements enable row level security;

create policy enrollments_client_select on public.enrollments
  for select using (client_id = auth.uid());
create policy enrollments_trainer_select on public.enrollments
  for select using (trainer_id = auth.uid());

create policy esh_party_select on public.enrollment_status_history
  for select using (
    exists (select 1 from public.enrollments en
            where en.id = enrollment_status_history.enrollment_id
              and (en.client_id = auth.uid() or en.trainer_id = auth.uid()))
  );

create policy entitlements_party_select on public.entitlements
  for select using (client_id = auth.uid() or trainer_id = auth.uid());

-- Buyers can read their purchase snapshots.
create policy pps_buyer_select on public.program_purchase_snapshots
  for select using (
    exists (select 1 from public.enrollments en
            where en.purchase_snapshot_id = program_purchase_snapshots.id
              and en.client_id = auth.uid())
  );

-- Enrollment/entitlement writes are server-only (payment-driven state).
revoke insert, update, delete on public.enrollments from anon, authenticated;
revoke insert, update, delete on public.enrollment_status_history from anon, authenticated;
revoke insert, update, delete on public.entitlements from anon, authenticated;
