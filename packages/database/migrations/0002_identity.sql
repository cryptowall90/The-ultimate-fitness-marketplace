-- 0002: identity — users, roles, profiles, trainer profiles, locations,
-- specialties, credentials, availability, terms & consent.

-- Thin mirror of auth.users. Application data never references auth.users directly
-- except through this table, so the auth provider stays swappable.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  status public.user_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_touch before update on public.users
  for each row execute function app.touch_updated_at();

create table public.user_roles (
  user_id uuid not null references public.users (id) on delete cascade,
  role public.app_role not null,
  granted_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Real body for the role helper now that user_roles exists.
create or replace function app.has_role(check_role public.app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = check_role
  )
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_role('admin')
$$;

create or replace function app.is_moderator() returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_role('moderator') or app.has_role('admin')
$$;

-- Shared profile: safe-to-share display fields only.
create table public.profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  bio text not null default '' check (char_length(bio) <= 4000),
  avatar_media_id uuid, -- fk added after media table exists
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

create table public.client_profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  fitness_goals text not null default '' check (char_length(fitness_goals) <= 4000),
  preferred_training_style text not null default '' check (char_length(preferred_training_style) <= 500),
  general_availability text not null default '' check (char_length(general_availability) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger client_profiles_touch before update on public.client_profiles
  for each row execute function app.touch_updated_at();

create table public.trainer_profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  slug citext unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  headline text not null default '' check (char_length(headline) <= 140),
  about text not null default '' check (char_length(about) <= 8000),
  service_mode public.service_mode not null default 'online',
  years_experience int check (years_experience between 0 and 80),
  languages text[] not null default '{}',
  application_status public.trainer_application_status not null default 'draft',
  application_submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.users (id),
  rejection_reason text,
  is_public boolean not null default false,
  is_accepting_clients boolean not null default true,
  business_name text check (char_length(business_name) <= 200),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- a profile may only be public once approved
  constraint public_requires_approval check (not is_public or application_status = 'approved')
);

create trigger trainer_profiles_touch before update on public.trainer_profiles
  for each row execute function app.touch_updated_at();

create index trainer_profiles_public_idx
  on public.trainer_profiles (application_status, is_public)
  where is_public and application_status = 'approved';

-- Service locations. `exact_location` (residential/studio) is PRIVATE.
-- `public_point` is a coarse city-level point used for radius search;
-- `service_area_label` is the safe public description.
create table public.trainer_service_locations (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  city_name text not null check (char_length(city_name) <= 120),
  region text check (char_length(region) <= 120),
  country_code char(2) not null,
  public_point geography(point, 4326) not null,
  exact_location geography(point, 4326),
  exact_address text check (char_length(exact_address) <= 500),
  service_radius_km numeric(6, 1) not null default 25 check (service_radius_km between 1 and 160),
  service_area_label text not null check (char_length(service_area_label) <= 200),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trainer_service_locations_touch before update on public.trainer_service_locations
  for each row execute function app.touch_updated_at();

create index trainer_service_locations_public_point_gist
  on public.trainer_service_locations using gist (public_point);
create index trainer_service_locations_trainer_idx
  on public.trainer_service_locations (trainer_id);
create unique index trainer_service_locations_one_primary
  on public.trainer_service_locations (trainer_id) where is_primary;

create table public.specialties (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name text not null check (char_length(name) <= 100),
  description text not null default '' check (char_length(description) <= 500),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.trainer_specialties (
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  specialty_id uuid not null references public.specialties (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trainer_id, specialty_id)
);

create index trainer_specialties_specialty_idx on public.trainer_specialties (specialty_id);

create table public.trainer_credentials (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  title text not null check (char_length(title) <= 200),
  issuing_organization text not null check (char_length(issuing_organization) <= 200),
  issued_at date,
  expires_at date,
  document_media_id uuid, -- fk added after media table exists
  status public.credential_status not null default 'pending',
  reviewed_by uuid references public.users (id),
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trainer_credentials_touch before update on public.trainer_credentials
  for each row execute function app.touch_updated_at();

create index trainer_credentials_trainer_idx on public.trainer_credentials (trainer_id);
create index trainer_credentials_pending_idx on public.trainer_credentials (status)
  where status = 'pending';

create table public.trainer_availability (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 1 and 1440),
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  constraint availability_range check (end_minute > start_minute),
  unique (trainer_id, day_of_week, start_minute, end_minute)
);

create table public.terms_versions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('terms_of_service', 'privacy_policy', 'trainer_agreement')),
  version text not null,
  content_url text not null,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (kind, version)
);

create table public.user_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  terms_version_id uuid not null references public.terms_versions (id),
  accepted_at timestamptz not null default now(),
  ip_hash text,
  unique (user_id, terms_version_id)
);

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  purpose text not null check (char_length(purpose) <= 200),
  granted boolean not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  source text not null default 'app' check (char_length(source) <= 100)
);

create index consent_records_user_idx on public.consent_records (user_id, purpose);

-- ---------------------------------------------------------------------------
-- Signup provisioning: mirror auth.users into public.users + default role.
-- ---------------------------------------------------------------------------

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id) values (new.id) on conflict do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'client') on conflict do nothing;
  insert into public.profiles (user_id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
    on conflict do nothing;
  insert into public.client_profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.user_roles enable row level security;
alter table public.profiles enable row level security;
alter table public.client_profiles enable row level security;
alter table public.trainer_profiles enable row level security;
alter table public.trainer_service_locations enable row level security;
alter table public.specialties enable row level security;
alter table public.trainer_specialties enable row level security;
alter table public.trainer_credentials enable row level security;
alter table public.trainer_availability enable row level security;
alter table public.terms_versions enable row level security;
alter table public.user_terms_acceptances enable row level security;
alter table public.consent_records enable row level security;

-- users: self read only. All writes via privileged server paths.
create policy users_select_self on public.users
  for select using (id = auth.uid());

-- user_roles: self read. Role grants are service-role only.
create policy user_roles_select_self on public.user_roles
  for select using (user_id = auth.uid());

-- profiles: self read/write; public trainer profiles readable by anyone.
create policy profiles_select_self on public.profiles
  for select using (user_id = auth.uid());
create policy profiles_select_public_trainer on public.profiles
  for select using (
    exists (
      select 1 from public.trainer_profiles tp
      where tp.user_id = profiles.user_id
        and tp.is_public and tp.application_status = 'approved'
    )
  );
create policy profiles_update_self on public.profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- client_profiles: self only here. Trainer access is added in 0006 (enrollments)
-- once the relationship function exists.
create policy client_profiles_select_self on public.client_profiles
  for select using (user_id = auth.uid());
create policy client_profiles_update_self on public.client_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- trainer_profiles: owner full read; anyone reads public approved rows.
create policy trainer_profiles_select_own on public.trainer_profiles
  for select using (user_id = auth.uid());
create policy trainer_profiles_select_public on public.trainer_profiles
  for select using (is_public and application_status = 'approved');
create policy trainer_profiles_insert_own on public.trainer_profiles
  for insert with check (user_id = auth.uid());
create policy trainer_profiles_update_own on public.trainer_profiles
  for update using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    -- owners cannot self-approve: status/approval columns protected by trigger below
  );

-- Prevent owners from changing privileged approval columns.
create or replace function app.protect_trainer_approval_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if app.is_service_context() then
    return new;
  end if;
  if new.application_status is distinct from old.application_status then
    -- Owner may only move draft -> submitted.
    if not (old.application_status = 'draft' and new.application_status = 'submitted'
            and old.user_id = auth.uid()) then
      raise exception 'application_status transition not permitted';
    end if;
    new.application_submitted_at := now();
  end if;
  if new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by
     or new.rejection_reason is distinct from old.rejection_reason then
    raise exception 'approval columns are managed by the platform';
  end if;
  return new;
end
$$;

create trigger trainer_profiles_protect_approval
  before update on public.trainer_profiles
  for each row execute function app.protect_trainer_approval_columns();

-- trainer_service_locations: owner-only. Public search goes through
-- app.search_trainers_nearby which returns safe columns only.
create policy tsl_owner_all on public.trainer_service_locations
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());

-- specialties: world-readable reference data; admin-managed.
create policy specialties_select_all on public.specialties
  for select using (true);

-- trainer_specialties: owner manages; anyone can read for public trainers.
create policy trainer_specialties_owner_all on public.trainer_specialties
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());
create policy trainer_specialties_select_public on public.trainer_specialties
  for select using (
    exists (
      select 1 from public.trainer_profiles tp
      where tp.user_id = trainer_specialties.trainer_id
        and tp.is_public and tp.application_status = 'approved'
    )
  );

-- trainer_credentials: owner reads/writes own (not status columns — trigger);
-- verified credentials of public trainers expose safe fields via view later.
create policy trainer_credentials_owner_select on public.trainer_credentials
  for select using (trainer_id = auth.uid());
create policy trainer_credentials_owner_insert on public.trainer_credentials
  for insert with check (trainer_id = auth.uid() and status = 'pending');
create policy trainer_credentials_owner_update on public.trainer_credentials
  for update using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());
create policy trainer_credentials_moderator_select on public.trainer_credentials
  for select using (app.is_moderator());

create or replace function app.protect_credential_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if app.is_service_context() then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.review_note is distinct from old.review_note then
    raise exception 'credential verification is managed by the platform';
  end if;
  -- editing a credential's content invalidates prior verification
  if old.status = 'verified' then
    new.status := 'pending';
  end if;
  return new;
end
$$;

create trigger trainer_credentials_protect_status
  before update on public.trainer_credentials
  for each row execute function app.protect_credential_status();

-- trainer_availability: owner manages; public readable for public trainers.
create policy trainer_availability_owner_all on public.trainer_availability
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());
create policy trainer_availability_select_public on public.trainer_availability
  for select using (
    exists (
      select 1 from public.trainer_profiles tp
      where tp.user_id = trainer_availability.trainer_id
        and tp.is_public and tp.application_status = 'approved'
    )
  );

-- terms: world readable.
create policy terms_versions_select_all on public.terms_versions
  for select using (true);

create policy user_terms_acceptances_select_self on public.user_terms_acceptances
  for select using (user_id = auth.uid());
create policy user_terms_acceptances_insert_self on public.user_terms_acceptances
  for insert with check (user_id = auth.uid());

create policy consent_records_select_self on public.consent_records
  for select using (user_id = auth.uid());
create policy consent_records_insert_self on public.consent_records
  for insert with check (user_id = auth.uid());
create policy consent_records_update_self on public.consent_records
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
