"use client";

import { useCallback, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

interface Report {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
  content: string | null;
}

const REMOVABLE = new Set(["review", "message"]);

async function getAccessToken(): Promise<string | null> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Fetches the reports queue from services/api and posts decisions back. */
export function ReportsQueue() {
  const [reports, setReports] = useState<Report[] | null>(null);
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
      const res = await fetch(`${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/moderation/reports`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError("The reports queue could not be loaded.");
        return;
      }
      const body = (await res.json()) as { reports: Report[] };
      setReports(body.reports);
    } catch {
      setError("The reports queue could not be loaded. Check your connection.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(report: Report, kind: "dismiss" | "action", removeContent: boolean) {
    const reason = (reasons[report.id] ?? "").trim();
    if (reason.length < 3) {
      setError("A decision reason (3+ characters) is required — it is recorded in the audit log.");
      return;
    }
    setBusyId(report.id);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session has expired — sign in again.");
        return;
      }
      const res = await fetch(
        `${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/moderation/reports/${report.id}/${kind}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ reason, removeContent }),
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

  if (reports === null && !error) return <p>Loading reports…</p>;

  return (
    <div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {reports !== null && reports.length === 0 ? <p>No open reports. All clear.</p> : null}
      {(reports ?? []).map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: "var(--space-lg)" }}>
          <h2>
            {r.targetType.replaceAll("_", " ")} report · {r.status}
          </h2>
          <p>
            <strong>Reported:</strong> {new Date(r.createdAt).toLocaleString()}
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>
            <strong>Reporter&apos;s reason:</strong> {r.reason}
          </p>
          {r.content !== null && (
            <blockquote
              style={{
                whiteSpace: "pre-wrap",
                borderLeft: "3px solid #ccc",
                paddingLeft: "0.75rem",
              }}
            >
              {r.content || "(empty)"}
            </blockquote>
          )}
          <div className="field">
            <label htmlFor={`mod-reason-${r.id}`}>Decision reason (audit-logged)</label>
            <input
              id={`mod-reason-${r.id}`}
              className="input"
              value={reasons[r.id] ?? ""}
              onChange={(e) => setReasons((prev) => ({ ...prev, [r.id]: e.target.value }))}
              maxLength={2000}
              placeholder="e.g. Violates review policy §3"
            />
          </div>
          <div style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" }}>
            {REMOVABLE.has(r.targetType) && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyId === r.id}
                aria-busy={busyId === r.id}
                onClick={() => decide(r, "action", true)}
              >
                Remove content
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busyId === r.id}
              aria-busy={busyId === r.id}
              onClick={() => decide(r, "action", false)}
            >
              Mark actioned
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busyId === r.id}
              aria-busy={busyId === r.id}
              onClick={() => decide(r, "dismiss", false)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
