"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

/**
 * POSTs to a services/api endpoint with the user's bearer token and follows
 * the returned provider URL (Stripe Checkout / Connect onboarding). The
 * browser sends no amounts or account ids — the server derives everything
 * from the authenticated user.
 */
export function ApiRedirectButton({
  path,
  label,
  busyLabel,
  className = "btn btn-primary",
}: {
  path: string;
  label: string;
  busyLabel: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setMessage(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        router.push(`/auth/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      const res = await fetch(`${publicEnv().NEXT_PUBLIC_API_BASE_URL}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setMessage(body?.error?.message ?? "Something went wrong. Please try again.");
        setBusy(false);
        return;
      }
      const body = (await res.json()) as { url: string };
      window.location.assign(body.url);
    } catch {
      setMessage("Something went wrong. Please check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className={className} onClick={go} disabled={busy} aria-busy={busy}>
        {busy ? busyLabel : label}
      </button>
      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
