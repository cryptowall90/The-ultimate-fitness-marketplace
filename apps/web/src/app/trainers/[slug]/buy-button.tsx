"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";

/**
 * Starts checkout via services/api. The server prices the order from the
 * published program version; this component sends only the program id.
 * No optimistic success — the purchase is confirmed by webhook only.
 */
export function BuyProgramButton({
  programId,
  signedIn,
}: {
  programId: string;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function startCheckout() {
    if (!signedIn) {
      router.push(`/auth/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        router.push("/auth/sign-in");
        return;
      }
      const res = await fetch(`${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/checkout/programs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ programId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setState("error");
        setMessage(body?.error?.message ?? "Checkout could not be started. Please try again.");
        return;
      }
      const body = (await res.json()) as { checkoutUrl: string };
      window.location.assign(body.checkoutUrl);
    } catch {
      setState("error");
      setMessage("Checkout could not be started. Please check your connection and try again.");
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={startCheckout}
        disabled={state === "loading"}
        aria-busy={state === "loading"}
      >
        {state === "loading" ? "Preparing secure checkout…" : "Buy program"}
      </button>
      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
