-- 0005: programs, immutable versions, and purchase snapshots.

create table public.programs (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  slug citext not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  title text not null check (char_length(title) between 3 and 140),
  summary text not null default '' check (char_length(summary) <= 500),
  full_description text not null default '' check (char_length(full_description) <= 20000),
  delivery_mode public.service_mode not null default 'online',
  pricing_type public.pricing_type not null default 'one_time',
  price_cents int not null check (price_cents between 0 and 100000000),
  currency char(3) not null default 'usd',
  duration_value int not null check (duration_value between 1 and 730),
  duration_unit public.duration_unit not null default 'week',
  recurrence_interval public.duration_unit, -- for recurring programs
  recurrence_interval_count int check (recurrence_interval_count between 1 and 12),
  capacity int check (capacity between 1 and 10000),
  approval_policy public.enrollment_approval_policy not null default 'automatic',
  included_features text[] not null default '{}',
  cancellation_terms text not null default '' check (char_length(cancellation_terms) <= 4000),
  refund_policy text not null default '' check (char_length(refund_policy) <= 4000),
  visibility text not null default 'public' check (visibility in ('public', 'unlisted')),
  status public.program_status not null default 'draft',
  version int not null default 1,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trainer_id, slug),
  constraint recurring_config check (
    pricing_type <> 'recurring'
    or (recurrence_interval is not null and recurrence_interval_count is not null)
  )
);

create trigger programs_touch before update on public.programs
  for each row execute function app.touch_updated_at();

create index programs_trainer_idx on public.programs (trainer_id, status);
create index programs_published_idx on public.programs (status, visibility, published_at desc)
  where status = 'published' and visibility = 'public';
create index programs_title_trgm on public.programs using gin (title gin_trgm_ops);

-- Immutable snapshot of a program at each published version.
create table public.program_versions (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id) on delete cascade,
  version int not null,
  snapshot jsonb not null, -- full program fields at publish time
  created_at timestamptz not null default now(),
  unique (program_id, version)
);

-- What a specific client actually bought. Referenced by enrollments/orders.
create table public.program_purchase_snapshots (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id),
  program_version_id uuid not null references public.program_versions (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  title text not null,
  price_cents int not null check (price_cents >= 0),
  currency char(3) not null,
  duration_value int not null,
  duration_unit public.duration_unit not null,
  pricing_type public.pricing_type not null,
  delivery_mode public.service_mode not null,
  cancellation_terms text not null default '',
  refund_policy text not null default '',
  included_features text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index pps_program_idx on public.program_purchase_snapshots (program_id);

create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is immutable', tg_table_name;
end
$$;

create trigger program_versions_immutable
  before update or delete on public.program_versions
  for each row execute function app.forbid_mutation();
create trigger pps_immutable
  before update or delete on public.program_purchase_snapshots
  for each row execute function app.forbid_mutation();

-- Program state machine at the database level.
create or replace function app.validate_program_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'draft' and new.status = 'published')
     or (old.status = 'published' and new.status in ('paused', 'archived'))
     or (old.status = 'paused' and new.status in ('published', 'archived')) then
    if new.status = 'published' and old.status = 'draft' then
      new.published_at := coalesce(new.published_at, now());
    end if;
    if new.status = 'archived' then
      new.archived_at := now();
    end if;
    return new;
  end if;
  raise exception 'invalid program status transition % -> %', old.status, new.status;
end
$$;

create trigger programs_validate_transition
  before update on public.programs
  for each row execute function app.validate_program_transition();

-- Publishing captures an immutable version snapshot.
create or replace function app.snapshot_program_on_publish() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'published' and (old.status is distinct from 'published' or new.version > old.version) then
    insert into public.program_versions (program_id, version, snapshot)
    values (
      new.id,
      new.version,
      jsonb_build_object(
        'title', new.title, 'summary', new.summary, 'full_description', new.full_description,
        'delivery_mode', new.delivery_mode, 'pricing_type', new.pricing_type,
        'price_cents', new.price_cents, 'currency', new.currency,
        'duration_value', new.duration_value, 'duration_unit', new.duration_unit,
        'capacity', new.capacity, 'approval_policy', new.approval_policy,
        'included_features', to_jsonb(new.included_features),
        'cancellation_terms', new.cancellation_terms, 'refund_policy', new.refund_policy
      )
    )
    on conflict (program_id, version) do nothing;
  end if;
  return new;
end
$$;

create trigger programs_snapshot_on_publish
  after update on public.programs
  for each row execute function app.snapshot_program_on_publish();

create trigger programs_snapshot_on_insert_published
  after insert on public.programs
  for each row when (new.status = 'published')
  execute function app.snapshot_program_on_publish();

-- RLS
alter table public.programs enable row level security;
alter table public.program_versions enable row level security;
alter table public.program_purchase_snapshots enable row level security;

create policy programs_owner_all on public.programs
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());
create policy programs_select_published on public.programs
  for select using (
    status in ('published', 'paused')
    and exists (
      select 1 from public.trainer_profiles tp
      where tp.user_id = programs.trainer_id
        and tp.is_public and tp.application_status = 'approved'
    )
  );

create policy program_versions_owner_select on public.program_versions
  for select using (
    exists (select 1 from public.programs p
            where p.id = program_versions.program_id and p.trainer_id = auth.uid())
  );

-- Purchase snapshots readable by the buyer (via enrollment policy added in 0007)
-- and by the trainer who owns them.
create policy pps_trainer_select on public.program_purchase_snapshots
  for select using (trainer_id = auth.uid());

revoke insert, update, delete on public.program_versions from anon, authenticated;
revoke insert, update, delete on public.program_purchase_snapshots from anon, authenticated;
