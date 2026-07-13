import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "CRM" };
export const dynamic = "force-dynamic";

/**
 * CRM overview: client roster and open tasks. crm_client_records rows are
 * created by the enrollment webhook; every query here is tenant-isolated by
 * owner RLS on the CRM tables.
 */
export default async function CrmOverviewPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/crm");

  const [{ data: trainer }, { data: records }, { data: tasks }] = await Promise.all([
    supabase
      .from("trainer_profiles")
      .select("application_status")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("crm_client_records")
      .select("id, client_id, stage, risk_flag, last_activity_at")
      .eq("trainer_id", user.id)
      .order("last_activity_at", { ascending: false, nullsFirst: false })
      .limit(100),
    supabase
      .from("tasks")
      .select("id, title, priority, due_at, client_id")
      .eq("trainer_id", user.id)
      .in("status", ["open", "in_progress"])
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(20),
  ]);

  if (!trainer) {
    return (
      <div>
        <h1>CRM</h1>
        <div className="card">
          <p>
            The CRM is available once you have a trainer profile.{" "}
            <Link href="/trainer/apply">Apply to become a trainer</Link>.
          </p>
        </div>
      </div>
    );
  }

  const clientIds = [...new Set((records ?? []).map((r) => r.client_id))];
  const { data: profiles } = clientIds.length
    ? await supabase.from("profiles").select("user_id, display_name").in("user_id", clientIds)
    : { data: [] };
  const nameById = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));

  const activeCount = (records ?? []).filter((r) => r.stage === "active_client").length;

  return (
    <div>
      <h1>CRM</h1>
      <p>
        {activeCount} active {activeCount === 1 ? "client" : "clients"} · {(tasks ?? []).length}{" "}
        open {(tasks ?? []).length === 1 ? "task" : "tasks"} ·{" "}
        <Link href="/trainer/programs">Programs</Link> ·{" "}
        <Link href="/trainer/settings/billing">Billing</Link>
      </p>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Clients</h2>
        {(records ?? []).length === 0 ? (
          <p>No clients yet — client records appear automatically after a purchase.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Stage</th>
                <th scope="col">Risk</th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {(records ?? []).map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/trainer/crm/clients/${r.id}`}>
                      {nameById.get(r.client_id) || "Client"}
                    </Link>
                  </td>
                  <td>{r.stage.replaceAll("_", " ")}</td>
                  <td>{r.risk_flag ? r.risk_flag.replaceAll("_", " ") : "—"}</td>
                  <td>
                    {r.last_activity_at ? new Date(r.last_activity_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Open tasks</h2>
        {(tasks ?? []).length === 0 ? (
          <p>No open tasks. Add tasks from a client&apos;s page.</p>
        ) : (
          <ul>
            {(tasks ?? []).map((t) => (
              <li key={t.id}>
                {t.title} · {t.priority}
                {t.due_at ? ` · due ${new Date(t.due_at).toLocaleDateString()}` : ""}
                {t.client_id && nameById.get(t.client_id) ? ` · ${nameById.get(t.client_id)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
