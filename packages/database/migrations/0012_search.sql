-- 0012: search. Server-enforced radius cap, pagination caps, safe public
-- columns only (no exact locations), stable sorting for cursor pagination.

create index trainer_profiles_headline_trgm
  on public.trainer_profiles using gin (headline gin_trgm_ops);
create index trainer_profiles_about_fts
  on public.trainer_profiles using gin (to_tsvector('english', about));

-- Safe public search row. NEVER include exact_location / exact_address.
create or replace function app.search_trainers_nearby(
  p_lat double precision,
  p_lng double precision,
  p_radius_km double precision default 40,
  p_specialty_slug text default null,
  p_min_weighted_rating numeric default null,
  p_limit int default 20,
  p_cursor_distance_m double precision default null,
  p_cursor_trainer_id uuid default null
) returns table (
  trainer_id uuid,
  display_name text,
  headline text,
  slug citext,
  service_mode public.service_mode,
  service_area_label text,
  city_name text,
  distance_m double precision,
  average_rating numeric,
  weighted_rating numeric,
  review_count int
)
language sql stable security definer set search_path = public as $$
  with params as (
    select
      st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography as origin,
      -- HARD CAP: radius is clamped to 160 km (100 miles) server-side.
      least(greatest(coalesce(p_radius_km, 40), 1), 160) * 1000 as radius_m,
      -- HARD CAP: page size clamped to 50.
      least(greatest(coalesce(p_limit, 20), 1), 50) as lim
  ),
  candidates as (
    select
      tp.user_id as trainer_id,
      pr.display_name,
      tp.headline,
      tp.slug,
      tp.service_mode,
      tsl.service_area_label,
      tsl.city_name,
      st_distance(tsl.public_point, params.origin) as distance_m,
      trs.average_rating,
      coalesce(trs.weighted_rating, 3.5) as weighted_rating,
      coalesce(trs.review_count, 0) as review_count
    from public.trainer_profiles tp
    join public.profiles pr on pr.user_id = tp.user_id
    join public.trainer_service_locations tsl on tsl.trainer_id = tp.user_id
    left join public.trainer_rating_summaries trs on trs.trainer_id = tp.user_id
    cross join params
    where tp.is_public
      and tp.application_status = 'approved'
      and tp.service_mode in ('in_person', 'hybrid')
      and st_dwithin(tsl.public_point, params.origin, params.radius_m)
      and (p_specialty_slug is null or exists (
        select 1 from public.trainer_specialties ts
        join public.specialties s on s.id = ts.specialty_id
        where ts.trainer_id = tp.user_id and s.slug = p_specialty_slug
      ))
      and (p_min_weighted_rating is null
           or coalesce(trs.weighted_rating, 3.5) >= p_min_weighted_rating)
  ),
  deduped as (
    -- a trainer may serve several nearby cities; keep the closest location
    select distinct on (trainer_id) *
    from candidates
    order by trainer_id, distance_m
  )
  select trainer_id, display_name, headline, slug, service_mode, service_area_label,
         city_name, distance_m, average_rating, weighted_rating, review_count
  from deduped
  where
    -- keyset cursor: stable (distance, id) ordering
    p_cursor_distance_m is null
    or (distance_m, trainer_id) > (p_cursor_distance_m, coalesce(p_cursor_trainer_id, '00000000-0000-0000-0000-000000000000'::uuid))
  order by distance_m, trainer_id
  limit (select lim from params)
$$;

-- Online trainer search with relevance + rating ranking and keyset pagination.
create or replace function app.search_trainers_online(
  p_query text default null,
  p_specialty_slug text default null,
  p_language text default null,
  p_min_weighted_rating numeric default null,
  p_limit int default 20,
  p_cursor_rank numeric default null,
  p_cursor_trainer_id uuid default null
) returns table (
  trainer_id uuid,
  display_name text,
  headline text,
  slug citext,
  service_mode public.service_mode,
  average_rating numeric,
  weighted_rating numeric,
  review_count int,
  rank numeric
)
language sql stable security definer set search_path = public as $$
  with params as (
    select least(greatest(coalesce(p_limit, 20), 1), 50) as lim,
           nullif(trim(coalesce(p_query, '')), '') as q
  ),
  scored as (
    select
      tp.user_id as trainer_id,
      pr.display_name,
      tp.headline,
      tp.slug,
      tp.service_mode,
      trs.average_rating,
      coalesce(trs.weighted_rating, 3.5) as weighted_rating,
      coalesce(trs.review_count, 0) as review_count,
      round(
        (coalesce(trs.weighted_rating, 3.5) / 5.0) * 0.6
        + case
            when params.q is null then 0.4
            else least(similarity(tp.headline || ' ' || pr.display_name, params.q)::numeric, 1.0) * 0.4
          end,
        6
      ) as rank
    from public.trainer_profiles tp
    join public.profiles pr on pr.user_id = tp.user_id
    left join public.trainer_rating_summaries trs on trs.trainer_id = tp.user_id
    cross join params
    where tp.is_public
      and tp.application_status = 'approved'
      and tp.service_mode in ('online', 'hybrid')
      and (params.q is null
           or tp.headline % params.q
           or pr.display_name % params.q
           or to_tsvector('english', tp.about) @@ plainto_tsquery('english', params.q))
      and (p_specialty_slug is null or exists (
        select 1 from public.trainer_specialties ts
        join public.specialties s on s.id = ts.specialty_id
        where ts.trainer_id = tp.user_id and s.slug = p_specialty_slug
      ))
      and (p_language is null or p_language = any (tp.languages))
      and (p_min_weighted_rating is null
           or coalesce(trs.weighted_rating, 3.5) >= p_min_weighted_rating)
  )
  select trainer_id, display_name, headline, slug, service_mode,
         average_rating, weighted_rating, review_count, rank
  from scored
  where p_cursor_rank is null
     or (rank, trainer_id) < (p_cursor_rank, coalesce(p_cursor_trainer_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
  order by rank desc, trainer_id desc
  limit (select lim from params)
$$;

grant execute on function app.search_trainers_nearby to anon, authenticated;
grant execute on function app.search_trainers_online to anon, authenticated;
