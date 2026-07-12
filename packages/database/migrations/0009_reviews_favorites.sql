-- 0009: reviews (one per verified enrollment, 1–5 integer rating, moderation
-- history preserved), review reports, favorites, and rating aggregates.

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  reviewer_client_id uuid not null references public.users (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  enrollment_id uuid not null references public.enrollments (id),
  rating int not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 4000),
  moderation_status public.review_moderation_status not null default 'published',
  is_verified_purchase boolean not null default true,
  edited_at timestamptz,
  published_at timestamptz default now(),
  removed_at timestamptz,
  removal_reason text check (char_length(removal_reason) <= 500),
  trainer_response text check (char_length(trainer_response) <= 2000),
  trainer_responded_at timestamptz,
  report_count int not null default 0 check (report_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One review per enrollment (the trainer relationship instance).
  unique (enrollment_id)
);

create trigger reviews_touch before update on public.reviews
  for each row execute function app.touch_updated_at();

create index reviews_trainer_idx on public.reviews (trainer_id, moderation_status, created_at desc);
create index reviews_reviewer_idx on public.reviews (reviewer_client_id);

-- Review eligibility: active enrollment with review entitlement, verified relationship.
create or replace function app.can_review(p_enrollment uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.enrollments en
    where en.id = p_enrollment
      and en.client_id = auth.uid()
      and en.status in ('active', 'paused')
      and app.has_entitlement(en.client_id, en.trainer_id, 'review')
  )
$$;

-- Guard privileged review columns and enforce edit window (active enrollment).
create or replace function app.protect_review_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if app.is_service_context() then return new; end if;

  if new.reviewer_client_id is distinct from old.reviewer_client_id
     or new.trainer_id is distinct from old.trainer_id
     or new.enrollment_id is distinct from old.enrollment_id
     or new.is_verified_purchase is distinct from old.is_verified_purchase
     or new.report_count is distinct from old.report_count then
    raise exception 'review identity columns are immutable';
  end if;

  if auth.uid() = old.reviewer_client_id then
    if new.moderation_status is distinct from old.moderation_status
       or new.removed_at is distinct from old.removed_at
       or new.removal_reason is distinct from old.removal_reason
       or new.trainer_response is distinct from old.trainer_response
       or new.trainer_responded_at is distinct from old.trainer_responded_at then
      raise exception 'moderation and response columns are not editable by the reviewer';
    end if;
    if not app.can_review(old.enrollment_id) then
      raise exception 'reviews may only be edited during an active enrollment';
    end if;
    new.edited_at := now();
  elsif auth.uid() = old.trainer_id then
    -- Trainer may ONLY set/update the response fields.
    if new.rating is distinct from old.rating
       or new.comment is distinct from old.comment
       or new.moderation_status is distinct from old.moderation_status
       or new.removed_at is distinct from old.removed_at
       or new.removal_reason is distinct from old.removal_reason
       or new.edited_at is distinct from old.edited_at
       or new.published_at is distinct from old.published_at then
      raise exception 'trainers may only respond to reviews';
    end if;
    new.trainer_responded_at := now();
  else
    raise exception 'not permitted';
  end if;
  return new;
end
$$;

create trigger reviews_protect_columns
  before update on public.reviews
  for each row execute function app.protect_review_columns();

-- Rating aggregates, recomputed by trusted trigger logic (server-side only).
create table public.trainer_rating_summaries (
  trainer_id uuid primary key references public.trainer_profiles (user_id) on delete cascade,
  review_count int not null default 0,
  rating_sum int not null default 0,
  average_rating numeric(3, 2),
  -- Bayesian-smoothed score used for ranking (prior m=3.5, weight c=5).
  weighted_rating numeric(4, 3),
  updated_at timestamptz not null default now()
);

create or replace function app.recompute_trainer_rating(p_trainer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_sum int;
  c_prior_weight constant numeric := 5;
  c_prior_mean constant numeric := 3.5;
begin
  select count(*), coalesce(sum(rating), 0) into v_count, v_sum
  from public.reviews
  where trainer_id = p_trainer and moderation_status = 'published';

  insert into public.trainer_rating_summaries as trs
    (trainer_id, review_count, rating_sum, average_rating, weighted_rating, updated_at)
  values (
    p_trainer, v_count, v_sum,
    case when v_count > 0 then round(v_sum::numeric / v_count, 2) end,
    round((c_prior_weight * c_prior_mean + v_sum) / (c_prior_weight + v_count), 3),
    now()
  )
  on conflict (trainer_id) do update set
    review_count = excluded.review_count,
    rating_sum = excluded.rating_sum,
    average_rating = excluded.average_rating,
    weighted_rating = excluded.weighted_rating,
    updated_at = now();
end
$$;

create or replace function app.reviews_recompute_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.recompute_trainer_rating(coalesce(new.trainer_id, old.trainer_id));
  return coalesce(new, old);
end
$$;

create trigger reviews_recompute_rating
  after insert or update or delete on public.reviews
  for each row execute function app.reviews_recompute_trigger();

create table public.review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews (id) on delete cascade,
  reporter_id uuid not null references public.users (id),
  reason text not null check (char_length(reason) between 3 and 1000),
  status public.report_status not null default 'open',
  created_at timestamptz not null default now(),
  unique (review_id, reporter_id)
);

create table public.favorites (
  user_id uuid not null references public.users (id) on delete cascade,
  trainer_id uuid references public.trainer_profiles (user_id) on delete cascade,
  program_id uuid references public.programs (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint favorite_target check (
    (trainer_id is not null and program_id is null)
    or (trainer_id is null and program_id is not null)
  )
);

create unique index favorites_trainer_unique on public.favorites (user_id, trainer_id)
  where trainer_id is not null;
create unique index favorites_program_unique on public.favorites (user_id, program_id)
  where program_id is not null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.reviews enable row level security;
alter table public.trainer_rating_summaries enable row level security;
alter table public.review_reports enable row level security;
alter table public.favorites enable row level security;

-- Published reviews of public trainers are world-readable; parties see their own.
create policy reviews_select_published on public.reviews
  for select using (
    moderation_status = 'published'
    and exists (select 1 from public.trainer_profiles tp
                where tp.user_id = reviews.trainer_id
                  and tp.is_public and tp.application_status = 'approved')
  );
create policy reviews_select_own on public.reviews
  for select using (reviewer_client_id = auth.uid() or trainer_id = auth.uid());
create policy reviews_select_moderator on public.reviews
  for select using (app.is_moderator());

create policy reviews_insert_eligible on public.reviews
  for insert with check (
    reviewer_client_id = auth.uid()
    and app.can_review(enrollment_id)
    and trainer_id = (select en.trainer_id from public.enrollments en where en.id = enrollment_id)
    and moderation_status = 'published'
  );

create policy reviews_update_reviewer on public.reviews
  for update using (reviewer_client_id = auth.uid())
  with check (reviewer_client_id = auth.uid());
create policy reviews_update_trainer_response on public.reviews
  for update using (trainer_id = auth.uid())
  with check (trainer_id = auth.uid());

create policy trainer_rating_summaries_select_all on public.trainer_rating_summaries
  for select using (true);
revoke insert, update, delete on public.trainer_rating_summaries from anon, authenticated;

create policy review_reports_insert on public.review_reports
  for insert with check (reporter_id = auth.uid());
create policy review_reports_select_own on public.review_reports
  for select using (reporter_id = auth.uid() or app.is_moderator());

create policy favorites_own_all on public.favorites
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
