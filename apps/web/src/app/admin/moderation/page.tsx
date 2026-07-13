import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ReportsQueue } from "./reports-queue";

export const metadata: Metadata = { title: "Moderation" };
export const dynamic = "force-dynamic";

/**
 * Moderation queue. The role check here is UX only — the real authorization
 * is the moderator role check inside services/api, and content removal only
 * happens there (service context + admin_actions audit).
 */
export default async function ModerationPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/admin/moderation");

  const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
  if (!(roles ?? []).some((r) => r.role === "moderator" || r.role === "admin")) redirect("/");

  return (
    <div>
      <h1>Moderation</h1>
      <ReportsQueue />
    </div>
  );
}
