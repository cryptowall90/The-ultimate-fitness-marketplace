import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Coaching" };
export const dynamic = "force-dynamic";

/**
 * Client portal: notes and assignments the trainer chose to share, plus
 * check-in schedule. RLS: clients read only rows addressed to them and may
 * only mark their own assignments complete. Private trainer notes live in a
 * different table entirely and can never appear here.
 */

async function completeAssignmentAction(formData: FormData): Promise<void> {
  "use server";
  const noteId = String(formData.get("noteId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(noteId)) notFound();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/coaching");

  await supabase
    .from("client_visible_notes")
    .update({ completed_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("client_id", user.id)
    .is("completed_at", null);
  revalidatePath("/coaching");
  redirect("/coaching");
}

export default async function CoachingPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/coaching");

  const [{ data: notes }, { data: checkIns }] = await Promise.all([
    supabase
      .from("client_visible_notes")
      .select("id, trainer_id, title, body, kind, due_at, completed_at, created_at")
      .eq("client_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("check_ins")
      .select("id, status, due_at")
      .eq("client_id", user.id)
      .order("due_at", { ascending: false })
      .limit(10),
  ]);

  const trainerIds = [...new Set((notes ?? []).map((n) => n.trainer_id))];
  const { data: trainers } = trainerIds.length
    ? await supabase.from("profiles").select("user_id, display_name").in("user_id", trainerIds)
    : { data: [] };
  const trainerName = new Map((trainers ?? []).map((p) => [p.user_id, p.display_name]));

  return (
    <div>
      <h1>Your coaching</h1>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Notes &amp; assignments from your trainer</h2>
        {(notes ?? []).length === 0 ? (
          <p>
            Nothing here yet — your trainer&apos;s shared notes and assignments will appear here.
          </p>
        ) : (
          (notes ?? []).map((n) => (
            <div key={n.id} style={{ padding: "var(--space-sm) 0" }}>
              <p>
                <strong>{n.title}</strong> · {n.kind}
                {trainerName.get(n.trainer_id) ? ` · from ${trainerName.get(n.trainer_id)}` : ""}
                {n.due_at ? ` · due ${new Date(n.due_at).toLocaleDateString()}` : ""}
              </p>
              {n.body && <p style={{ whiteSpace: "pre-wrap" }}>{n.body}</p>}
              {n.kind === "assignment" &&
                (n.completed_at ? (
                  <p>✓ Completed {new Date(n.completed_at).toLocaleDateString()}</p>
                ) : (
                  <form action={completeAssignmentAction}>
                    <input type="hidden" name="noteId" value={n.id} />
                    <button className="btn btn-secondary" type="submit">
                      Mark complete
                    </button>
                  </form>
                ))}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Check-ins</h2>
        {(checkIns ?? []).length === 0 ? (
          <p>No check-ins scheduled.</p>
        ) : (
          <ul>
            {(checkIns ?? []).map((c) => (
              <li key={c.id}>
                {c.status.replaceAll("_", " ")} · due {new Date(c.due_at).toLocaleDateString()}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
