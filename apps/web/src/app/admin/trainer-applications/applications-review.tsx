"use client";

import { useCallback, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

interface Credential {
  title: string;
  issuingOrganization: string;
  issuedAt: string | null;
  expiresAt: string | null;
  status: string;
}

interface Application {
  trainerId: string;
  displayName: string;
  slug: string | null;
  headline: string;
  about: string;
  serviceMode: string;
  yearsExperience: number | null;
  languages: string[];
  businessName: string | null;
  submittedAt: string | null;
  specialties: string[];
  credentials: Credential[];
}

async function getAccessToken(): Promise<string | null> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Fetches the review queue from services/api and posts decisions back. */
export function ApplicationsReview() {
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session has expired — sign in again.");
        return;
      }
      const res = await fetch(
        `${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/admin/trainer-applications`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        setError("The application queue could not be loaded.");
        return;
      }
      const body = (await res.json()) as { applications: Application[] };
      setApplications(body.applications);
    } catch {
      setError("The application queue could not be loaded. Check your connection.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(trainerId: string, action: "approve" | "reject") {
    const reason = (reasons[trainerId] ?? "").trim();
    if (reason.length < 3) {
      setError("A decision reason (3+ characters) is required — it is recorded in the audit log.");
      return;
    }
    setBusyId(trainerId);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session has expired — sign in again.");
        return;
      }
      const res = await fetch(
        `${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/admin/trainer-applications/${trainerId}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ reason }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? "The decision could not be saved.");
        return;
      }
      await load();
    } catch {
      setError("The decision could not be saved. Check your connection.");
    } finally {
      setBusyId(null);
    }
  }

  if (applications === null && !error) return <p>Loading applications…</p>;

  return (
    <div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {applications !== null && applications.length === 0 ? (
        <p>No applications are waiting for review.</p>
      ) : null}
      {(applications ?? []).map((a) => (
        <div key={a.trainerId} className="card" style={{ marginBottom: "var(--space-lg)" }}>
          <h2>{a.displayName || "Unnamed applicant"}</h2>
          <p>
            <strong>{a.headline}</strong>
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{a.about}</p>
          <ul>
            <li>Service mode: {a.serviceMode.replaceAll("_", " ")}</li>
            {a.yearsExperience !== null && <li>Experience: {a.yearsExperience} years</li>}
            {a.languages.length > 0 && <li>Languages: {a.languages.join(", ")}</li>}
            {a.businessName && <li>Business: {a.businessName}</li>}
            {a.specialties.length > 0 && <li>Specialties: {a.specialties.join(", ")}</li>}
            {a.submittedAt && <li>Submitted: {new Date(a.submittedAt).toLocaleString()}</li>}
          </ul>
          <h3>Credentials</h3>
          {a.credentials.length === 0 ? (
            <p>No credentials provided.</p>
          ) : (
            <ul>
              {a.credentials.map((c, i) => (
                <li key={i}>
                  {c.title} — {c.issuingOrganization}
                  {c.issuedAt ? ` (issued ${c.issuedAt})` : ""} · {c.status}
                </li>
              ))}
            </ul>
          )}
          <div className="field">
            <label htmlFor={`reason-${a.trainerId}`}>Decision reason (audit-logged)</label>
            <input
              id={`reason-${a.trainerId}`}
              className="input"
              value={reasons[a.trainerId] ?? ""}
              onChange={(e) => setReasons((prev) => ({ ...prev, [a.trainerId]: e.target.value }))}
              maxLength={2000}
              placeholder="e.g. Credentials verified against NASM registry"
            />
          </div>
          <div style={{ display: "flex", gap: "var(--space-sm)" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busyId === a.trainerId}
              aria-busy={busyId === a.trainerId}
              onClick={() => decide(a.trainerId, "approve")}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busyId === a.trainerId}
              aria-busy={busyId === a.trainerId}
              onClick={() => decide(a.trainerId, "reject")}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
