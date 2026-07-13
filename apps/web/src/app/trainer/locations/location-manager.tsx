"use client";

import { useCallback, useEffect, useState } from "react";
import { trainerServiceLocationSchema } from "@fitmarket/validation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

interface LocationRow {
  id: string;
  city_name: string;
  region: string | null;
  country_code: string;
  service_radius_km: number;
  service_area_label: string;
  is_primary: boolean;
  exact_address: string | null;
}

const RADIUS_OPTIONS_KM = [8, 15, 25, 40, 80, 160];

async function getAccessToken(): Promise<string | null> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Lists own locations via RLS; creates/deletes through services/api. */
export function LocationManager() {
  const [locations, setLocations] = useState<LocationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const { data, error: loadError } = await supabase
      .from("trainer_service_locations")
      .select(
        "id, city_name, region, country_code, service_radius_km, service_area_label, is_primary, exact_address",
      )
      .order("created_at");
    if (loadError) {
      setError("Your locations could not be loaded.");
      return;
    }
    setLocations(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addLocation(formData: FormData) {
    const region = String(formData.get("region") ?? "").trim();
    const exactAddress = String(formData.get("exactAddress") ?? "").trim();
    const parsed = trainerServiceLocationSchema.safeParse({
      cityName: String(formData.get("cityName") ?? ""),
      ...(region ? { region } : {}),
      countryCode: String(formData.get("countryCode") ?? "").toUpperCase(),
      serviceRadiusKm: Number(formData.get("serviceRadiusKm") ?? 25),
      isPrimary: formData.get("isPrimary") === "on",
      ...(exactAddress ? { exactAddress } : {}),
    });
    if (!parsed.success) {
      setError("Check the city, two-letter country code and radius.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session has expired — sign in again.");
        return;
      }
      const res = await fetch(`${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/trainer/locations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        setError(
          body?.error?.code === "city_not_found"
            ? "We couldn't locate that city — check the spelling and country."
            : (body?.error?.message ?? "The location could not be saved."),
        );
        return;
      }
      await load();
    } catch {
      setError("The location could not be saved. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function removeLocation(id: string) {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session has expired — sign in again.");
        return;
      }
      const res = await fetch(
        `${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/trainer/locations/${id}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        setError("The location could not be removed.");
        return;
      }
      await load();
    } catch {
      setError("The location could not be removed. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Your locations</h2>
        {locations === null ? (
          <p>Loading…</p>
        ) : locations.length === 0 ? (
          <p>No locations yet — add the city you serve below.</p>
        ) : (
          <ul>
            {locations.map((l) => (
              <li key={l.id} style={{ padding: "var(--space-xs) 0" }}>
                <strong>{l.service_area_label}</strong>
                {l.is_primary && " · primary"}
                {l.exact_address && (
                  <span style={{ opacity: 0.7 }}> · {l.exact_address} (private)</span>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginLeft: "var(--space-sm)" }}
                  disabled={busy}
                  onClick={() => void removeLocation(l.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Add a location</h2>
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void addLocation(new FormData(e.currentTarget));
          }}
        >
          <div className="field">
            <label htmlFor="cityName">City</label>
            <input id="cityName" name="cityName" className="input" maxLength={120} required />
          </div>
          <div className="field">
            <label htmlFor="region">State / region (optional)</label>
            <input id="region" name="region" className="input" maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="countryCode">Country code</label>
            <input
              id="countryCode"
              name="countryCode"
              className="input"
              defaultValue="US"
              pattern="[A-Za-z]{2}"
              maxLength={2}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="serviceRadiusKm">Service radius</label>
            <select id="serviceRadiusKm" name="serviceRadiusKm" className="input" defaultValue="25">
              {RADIUS_OPTIONS_KM.map((km) => (
                <option key={km} value={km}>
                  {km} km (~{Math.round(km / 1.609)} mi)
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="exactAddress">Studio address (optional, never shown publicly)</label>
            <input id="exactAddress" name="exactAddress" className="input" maxLength={500} />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" name="isPrimary" /> Primary location
            </label>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "Saving…" : "Add location"}
          </button>
        </form>
      </div>
    </div>
  );
}
