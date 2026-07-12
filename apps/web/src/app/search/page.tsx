import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Search trainers" };
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  mode: z.enum(["online", "in_person"]).catch("online"),
  q: z.string().trim().max(120).optional(),
  specialty: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
  city: z.string().trim().max(120).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(160).catch(40),
});

interface SearchRow {
  trainer_id: string;
  display_name: string;
  headline: string;
  slug: string;
  service_mode: string;
  service_area_label?: string;
  city_name?: string;
  distance_m?: number;
  average_rating: number | null;
  weighted_rating: number;
  review_count: number;
}

/**
 * A small set of launch cities resolved server-side. The production geocoding
 * adapter (server-only, allowlisted egress) replaces this lookup; user input
 * is never sent to a third party from the browser.
 */
const CITY_COORDINATES: Record<string, { lat: number; lng: number }> = {
  austin: { lat: 30.2672, lng: -97.7431 },
  "new york": { lat: 40.7128, lng: -74.006 },
  "los angeles": { lat: 34.0522, lng: -118.2437 },
  chicago: { lat: 41.8781, lng: -87.6298 },
  houston: { lat: 29.7604, lng: -95.3698 },
  miami: { lat: 25.7617, lng: -80.1918 },
  seattle: { lat: 47.6062, lng: -122.3321 },
  denver: { lat: 39.7392, lng: -104.9903 },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = paramsSchema.parse({
    mode: raw.mode,
    q: typeof raw.q === "string" ? raw.q : undefined,
    specialty: typeof raw.specialty === "string" ? raw.specialty : undefined,
    city: typeof raw.city === "string" ? raw.city : undefined,
    lat: raw.lat,
    lng: raw.lng,
    radiusKm: raw.radiusKm,
  });

  const supabase = await createSupabaseServerClient();
  const { data: specialties } = await supabase
    .from("specialties")
    .select("slug, name")
    .eq("is_active", true)
    .order("name")
    .limit(30);

  let rows: SearchRow[] = [];
  let searchError: string | null = null;
  let cityNotFound = false;

  if (params.mode === "in_person") {
    let origin =
      params.lat !== undefined && params.lng !== undefined
        ? { lat: params.lat, lng: params.lng }
        : undefined;
    if (!origin && params.city) {
      origin = CITY_COORDINATES[params.city.toLowerCase()];
      if (!origin) cityNotFound = true;
    }
    if (origin) {
      const { data, error } = await supabase.rpc("search_trainers_nearby", {
        p_lat: origin.lat,
        p_lng: origin.lng,
        p_radius_km: params.radiusKm,
        p_specialty_slug: params.specialty ?? null,
        p_limit: 20,
      });
      if (error) searchError = "Search is temporarily unavailable.";
      rows = (data ?? []) as SearchRow[];
    }
  } else {
    const { data, error } = await supabase.rpc("search_trainers_online", {
      p_query: params.q ?? null,
      p_specialty_slug: params.specialty ?? null,
      p_limit: 20,
    });
    if (error) searchError = "Search is temporarily unavailable.";
    rows = (data ?? []) as SearchRow[];
  }

  const showResults =
    params.mode === "online" || params.lat !== undefined || Boolean(params.city);

  return (
    <div>
      <h1>Find a trainer</h1>
      <form className="search-form" action="/search" method="get">
        <div className="field">
          <label htmlFor="mode">Training type</label>
          <select id="mode" name="mode" defaultValue={params.mode} className="input">
            <option value="online">Online coaching</option>
            <option value="in_person">In person</option>
          </select>
        </div>
        {params.mode === "in_person" ? (
          <>
            <div className="field">
              <label htmlFor="city">City</label>
              <input
                id="city"
                name="city"
                className="input"
                defaultValue={params.city ?? ""}
                placeholder="e.g. Austin"
                maxLength={120}
              />
            </div>
            <div className="field">
              <label htmlFor="radiusKm">Radius</label>
              <select id="radiusKm" name="radiusKm" defaultValue={String(params.radiusKm)} className="input">
                <option value="8">5 miles</option>
                <option value="16">10 miles</option>
                <option value="24">15 miles</option>
                <option value="40">25 miles</option>
                <option value="80">50 miles</option>
                <option value="160">100 miles</option>
              </select>
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="q">Keywords</label>
            <input
              id="q"
              name="q"
              className="input"
              defaultValue={params.q ?? ""}
              placeholder="e.g. strength, marathon, kettlebell"
              maxLength={120}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="specialty">Specialty</label>
          <select id="specialty" name="specialty" defaultValue={params.specialty ?? ""} className="input">
            <option value="">Any specialty</option>
            {(specialties ?? []).map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {cityNotFound && (
        <p className="notice notice-error" role="alert">
          We couldn&apos;t find that city yet. Try one of our launch cities: Austin, New York,
          Los Angeles, Chicago, Houston, Miami, Seattle, Denver.
        </p>
      )}
      {searchError && (
        <p className="notice notice-error" role="alert">
          {searchError}
        </p>
      )}

      {showResults && !searchError && !cityNotFound && (
        <section aria-label="Search results">
          {rows.length === 0 ? (
            <div className="empty-state">
              <h2>No trainers found</h2>
              <p>Try widening the radius or removing filters.</p>
            </div>
          ) : (
            <div className="results-grid">
              {rows.map((row) => (
                <article key={row.trainer_id} className="card trainer-card">
                  <h3>
                    <Link href={`/trainers/${row.slug}`}>{row.display_name}</Link>
                  </h3>
                  <p>{row.headline}</p>
                  <div className="meta">
                    <span className="badge">
                      {row.service_mode === "online"
                        ? "Online"
                        : row.service_mode === "in_person"
                          ? "In person"
                          : "Online & in person"}
                    </span>
                    {row.service_area_label && <span className="badge">{row.service_area_label}</span>}
                    {typeof row.distance_m === "number" && (
                      <span>{(row.distance_m / 1609.34).toFixed(1)} mi away</span>
                    )}
                    <span aria-label={`Rated ${row.average_rating ?? "not yet rated"}`}>
                      {row.review_count > 0
                        ? `★ ${Number(row.average_rating).toFixed(1)} (${row.review_count})`
                        : "New trainer"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
