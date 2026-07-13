import { z } from "zod";
import type { Logger } from "@fitmarket/observability";

/**
 * Server-side geocoding (docs/GEOGRAPHIC_SEARCH.md). City text from users is
 * resolved HERE, never in the browser and never as a raw URL component:
 * the external adapter allowlists its host, encodes every parameter, refuses
 * redirects, times out, validates the response shape, and caches by
 * normalized city. The static launch-city table needs no egress at all.
 */

export interface GeocodeQuery {
  city: string;
  region?: string | undefined;
  countryCode: string;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  canonicalName: string;
}

export interface Geocoder {
  resolveCity(query: GeocodeQuery): Promise<GeocodeResult | null>;
}

const normalize = (q: GeocodeQuery): string =>
  [q.city.trim().toLowerCase(), (q.region ?? "").trim().toLowerCase(), q.countryCode.toUpperCase()]
    .join("|")
    .slice(0, 300);

/** Launch cities — resolved locally, no external calls. */
const LAUNCH_CITIES: Record<string, GeocodeResult> = {
  austin: { lat: 30.2672, lng: -97.7431, canonicalName: "Austin, TX" },
  "new york": { lat: 40.7128, lng: -74.006, canonicalName: "New York, NY" },
  "los angeles": { lat: 34.0522, lng: -118.2437, canonicalName: "Los Angeles, CA" },
  chicago: { lat: 41.8781, lng: -87.6298, canonicalName: "Chicago, IL" },
  houston: { lat: 29.7604, lng: -95.3698, canonicalName: "Houston, TX" },
  miami: { lat: 25.7617, lng: -80.1918, canonicalName: "Miami, FL" },
  seattle: { lat: 47.6062, lng: -122.3321, canonicalName: "Seattle, WA" },
  denver: { lat: 39.7392, lng: -104.9903, canonicalName: "Denver, CO" },
};

export class StaticCityGeocoder implements Geocoder {
  async resolveCity(query: GeocodeQuery): Promise<GeocodeResult | null> {
    if (query.countryCode.toUpperCase() !== "US") return null;
    return LAUNCH_CITIES[query.city.trim().toLowerCase()] ?? null;
  }
}

const nominatimResponseSchema = z.array(
  z.object({
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
    display_name: z.string().max(500),
  }),
);

const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_MAX_ENTRIES = 10_000;

/**
 * Nominatim-compatible external geocoder. The base URL is fixed at
 * construction (env-configured) — user input only ever appears as encoded
 * query parameters against that host.
 */
export class NominatimGeocoder implements Geocoder {
  private readonly baseUrl: URL;
  private readonly cache = new Map<string, GeocodeResult | null>();

  constructor(
    baseUrl: string,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:") {
      throw new Error("geocoder base url must be https");
    }
  }

  async resolveCity(query: GeocodeQuery): Promise<GeocodeResult | null> {
    const key = normalize(query);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("city", query.city.slice(0, 120));
    if (query.region) url.searchParams.set("state", query.region.slice(0, 120));
    url.searchParams.set("countrycodes", query.countryCode.toLowerCase());
    // Allowlist: the URL class guarantees the host can only be the
    // constructor's; assert anyway so a refactor cannot regress silently.
    if (url.host !== this.baseUrl.host) throw new Error("geocoder host mismatch");

    let result: GeocodeResult | null = null;
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
        headers: { accept: "application/json", "user-agent": "fitmarket-geocoder/1.0" },
      });
      if (res.ok) {
        const parsed = nominatimResponseSchema.safeParse(await res.json());
        const hit = parsed.success ? parsed.data[0] : undefined;
        if (!parsed.success) {
          this.log.warn("geocoder returned an unexpected response shape");
        }
        if (hit) {
          result = {
            lat: hit.lat,
            lng: hit.lon,
            canonicalName: hit.display_name.split(",").slice(0, 2).join(",").trim(),
          };
        }
      } else {
        this.log.warn({ status: res.status }, "geocoder request failed");
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "geocoder request errored");
      return null; // do not cache transport errors
    }

    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }
}

/** Tries geocoders in order; first hit wins (static launch table first). */
export class ChainGeocoder implements Geocoder {
  constructor(private readonly geocoders: Geocoder[]) {}

  async resolveCity(query: GeocodeQuery): Promise<GeocodeResult | null> {
    for (const geocoder of this.geocoders) {
      const result = await geocoder.resolveCity(query);
      if (result) return result;
    }
    return null;
  }
}
