import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ApplicationsReview } from "./applications-review";

export const metadata: Metadata = { title: "Trainer applications" };
export const dynamic = "force-dynamic";

/**
 * Admin review queue. This role check is UX only — the real authorization
 * happens in services/api (bearer token + user_roles lookup), and submitted
 * profiles are not readable through RLS in the first place.
 */
export default async function TrainerApplicationsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/admin/trainer-applications");

  const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
  if (!(roles ?? []).some((r) => r.role === "admin")) redirect("/");

  return (
    <div>
      <h1>Trainer applications</h1>
      <ApplicationsReview />
    </div>
  );
}
