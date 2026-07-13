-- 0013: public RPC wrappers for PostgREST/supabase-js. The underlying app.*
-- functions keep the hard caps (radius <= 160 km, limit <= 50); these
-- wrappers only expose them to the API surface.

create function public.search_trainers_nearby(
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
  select * from app.search_trainers_nearby(
    p_lat, p_lng, p_radius_km, p_specialty_slug, p_min_weighted_rating,
    p_limit, p_cursor_distance_m, p_cursor_trainer_id)
$$;

create function public.search_trainers_online(
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
  select * from app.search_trainers_online(
    p_query, p_specialty_slug, p_language, p_min_weighted_rating,
    p_limit, p_cursor_rank, p_cursor_trainer_id)
$$;

grant execute on function public.search_trainers_nearby to anon, authenticated;
grant execute on function public.search_trainers_online to anon, authenticated;
