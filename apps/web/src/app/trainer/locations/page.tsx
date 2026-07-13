import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { LocationManager } from "./location-manager";

export const metadata: Metadata = { title: "Service locations" };
export const dynamic = "force-dynamic";

/**
 * Trainer service locations. Creation goes through services/api so the
 * public search point is derived from server-side geocoding — the browser
 * never supplies coordinates. Exact addresses stay private (owner-only RLS)
 * and are never shown in search.
 */
export default async function TrainerLocationsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/locations");

  const { data: trainer } = await supabase
    .from("trainer_profiles")
    .select("application_status, service_mode")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!trainer) {
    return (
      <div>
        <h1>Service locations</h1>
        <div className="card">
          <p>
            Locations are available once you have a trainer profile.{" "}
            <Link href="/trainer/apply">Apply to become a trainer</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Service locations</h1>
      <p>
        Clients searching in person see your <strong>city and service area only</strong> — exact
        addresses are never shown publicly.
        {trainer.service_mode === "online" && (
          <>
            {" "}
            Your profile is currently online-only; set it to in-person or hybrid on{" "}
            <Link href="/trainer/apply">your profile</Link> to appear in local search.
          </>
        )}
      </p>
      <LocationManager />
    </div>
  );
}
