import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  clientVisibleNoteCreateSchema,
  taskCreateSchema,
  taskStatusSchema,
  trainerNoteCreateSchema,
} from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Client" };
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/;

/**
 * Client record detail. Owner RLS isolates every table touched here to the
 * signed-in trainer; private trainer_notes are structurally separate from
 * client_visible_notes so a private note can never leak to the client.
 */

async function requireTrainerAndRecord(recordId: string) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/trainer/crm/clients/${recordId}`);
  const { data: record } = await supabase
    .from("crm_client_records")
    .select("id, client_id, stage, risk_flag, last_activity_at")
    .eq("id", recordId)
    .eq("trainer_id", user.id)
    .maybeSingle();
  if (!record) notFound();
  return { supabase, user, record };
}

async function addPrivateNoteAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = String(formData.get("recordId") ?? "");
  if (!UUID_RE.test(recordId)) notFound();
  const { supabase, user, record } = await requireTrainerAndRecord(recordId);

  const parsed = trainerNoteCreateSchema.safeParse({
    clientId: record.client_id,
    body: String(formData.get("body") ?? ""),
  });
  if (!parsed.success) redirect(`/trainer/crm/clients/${recordId}?error=note`);

  const { error } = await supabase.from("trainer_notes").insert({
    trainer_id: user.id,
    client_id: parsed.data.clientId,
    body: parsed.data.body,
  });
  if (error) redirect(`/trainer/crm/clients/${recordId}?error=note`);
  revalidatePath(`/trainer/crm/clients/${recordId}`);
  redirect(`/trainer/crm/clients/${recordId}?saved=1`);
}

async function addSharedNoteAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = String(formData.get("recordId") ?? "");
  if (!UUID_RE.test(recordId)) notFound();
  const { supabase, user, record } = await requireTrainerAndRecord(recordId);

  const parsed = clientVisibleNoteCreateSchema.safeParse({
    clientId: record.client_id,
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    kind: String(formData.get("kind") ?? "note"),
  });
  if (!parsed.success) redirect(`/trainer/crm/clients/${recordId}?error=shared`);

  const { error } = await supabase.from("client_visible_notes").insert({
    trainer_id: user.id,
    client_id: parsed.data.clientId,
    title: parsed.data.title,
    body: parsed.data.body,
    kind: parsed.data.kind,
  });
  if (error) redirect(`/trainer/crm/clients/${recordId}?error=shared`);
  revalidatePath(`/trainer/crm/clients/${recordId}`);
  redirect(`/trainer/crm/clients/${recordId}?saved=1`);
}

async function addTaskAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = String(formData.get("recordId") ?? "");
  if (!UUID_RE.test(recordId)) notFound();
  const { supabase, user, record } = await requireTrainerAndRecord(recordId);

  const dueDate = String(formData.get("dueDate") ?? "");
  const parsed = taskCreateSchema.safeParse({
    clientId: record.client_id,
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    priority: String(formData.get("priority") ?? "medium"),
    ...(dueDate ? { dueAt: new Date(`${dueDate}T12:00:00Z`).toISOString() } : {}),
  });
  if (!parsed.success) redirect(`/trainer/crm/clients/${recordId}?error=task`);

  const { error } = await supabase.from("tasks").insert({
    trainer_id: user.id,
    client_id: parsed.data.clientId ?? null,
    title: parsed.data.title,
    description: parsed.data.description,
    priority: parsed.data.priority,
    due_at: parsed.data.dueAt ?? null,
  });
  if (error) redirect(`/trainer/crm/clients/${recordId}?error=task`);
  revalidatePath(`/trainer/crm/clients/${recordId}`);
  redirect(`/trainer/crm/clients/${recordId}?saved=1`);
}

async function completeTaskAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = String(formData.get("recordId") ?? "");
  if (!UUID_RE.test(recordId)) notFound();
  const { supabase, user } = await requireTrainerAndRecord(recordId);

  const parsed = taskStatusSchema.safeParse({
    taskId: String(formData.get("taskId") ?? ""),
    status: "done",
  });
  if (!parsed.success) redirect(`/trainer/crm/clients/${recordId}?error=task`);

  await supabase
    .from("tasks")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", parsed.data.taskId)
    .eq("trainer_id", user.id);
  revalidatePath(`/trainer/crm/clients/${recordId}`);
  redirect(`/trainer/crm/clients/${recordId}?saved=1`);
}

export default async function CrmClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { recordId } = await params;
  if (!UUID_RE.test(recordId)) notFound();
  const { supabase, user, record } = await requireTrainerAndRecord(recordId);
  const query = await searchParams;

  const [
    { data: profile },
    { data: privateNotes },
    { data: sharedNotes },
    { data: tasks },
    { data: checkIns },
  ] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("user_id", record.client_id).maybeSingle(),
    supabase
      .from("trainer_notes")
      .select("id, body, pinned, created_at")
      .eq("trainer_id", user.id)
      .eq("client_id", record.client_id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("client_visible_notes")
      .select("id, title, body, kind, due_at, completed_at, created_at")
      .eq("trainer_id", user.id)
      .eq("client_id", record.client_id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("tasks")
      .select("id, title, description, status, priority, due_at")
      .eq("trainer_id", user.id)
      .eq("client_id", record.client_id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("check_ins")
      .select("id, status, due_at, submission_id")
      .eq("trainer_id", user.id)
      .eq("client_id", record.client_id)
      .order("due_at", { ascending: false })
      .limit(10),
  ]);

  return (
    <div>
      <p>
        <Link href="/trainer/crm">← CRM</Link>
      </p>
      <h1>{profile?.display_name || "Client"}</h1>
      <p>
        Stage: {record.stage.replaceAll("_", " ")}
        {record.risk_flag ? ` · risk: ${record.risk_flag.replaceAll("_", " ")}` : ""}
      </p>

      {query.saved === "1" && (
        <p className="notice" role="status">
          Saved.
        </p>
      )}
      {typeof query.error === "string" && (
        <p className="notice notice-error" role="alert">
          That could not be saved — check the fields and try again.
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Private notes</h2>
        <p style={{ color: "var(--color-text-muted)" }}>
          Only you can see these — they are never shared with the client.
        </p>
        <form action={addPrivateNoteAction} className="form-stack">
          <input type="hidden" name="recordId" value={record.id} />
          <div className="field">
            <label htmlFor="privateBody">New private note</label>
            <textarea id="privateBody" name="body" className="input" rows={3} maxLength={8000} />
          </div>
          <button className="btn btn-secondary" type="submit">
            Add private note
          </button>
        </form>
        <ul>
          {(privateNotes ?? []).map((n) => (
            <li key={n.id} style={{ whiteSpace: "pre-wrap" }}>
              {n.body}
              <span style={{ opacity: 0.6 }}> — {new Date(n.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Shared notes &amp; assignments</h2>
        <p style={{ color: "var(--color-text-muted)" }}>Visible to the client.</p>
        <form action={addSharedNoteAction} className="form-stack">
          <input type="hidden" name="recordId" value={record.id} />
          <div className="field">
            <label htmlFor="sharedTitle">Title</label>
            <input id="sharedTitle" name="title" className="input" maxLength={200} required />
          </div>
          <div className="field">
            <label htmlFor="sharedBody">Details</label>
            <textarea id="sharedBody" name="body" className="input" rows={3} maxLength={8000} />
          </div>
          <div className="field">
            <label htmlFor="sharedKind">Type</label>
            <select id="sharedKind" name="kind" className="input" defaultValue="note">
              <option value="note">Note</option>
              <option value="assignment">Assignment</option>
            </select>
          </div>
          <button className="btn btn-secondary" type="submit">
            Share with client
          </button>
        </form>
        <ul>
          {(sharedNotes ?? []).map((n) => (
            <li key={n.id}>
              <strong>{n.title}</strong> ({n.kind}){n.body ? ` — ${n.body}` : ""}
              {n.completed_at ? " · completed" : ""}
            </li>
          ))}
        </ul>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Tasks</h2>
        <form action={addTaskAction} className="form-stack">
          <input type="hidden" name="recordId" value={record.id} />
          <div className="field">
            <label htmlFor="taskTitle">Task</label>
            <input id="taskTitle" name="title" className="input" maxLength={200} required />
          </div>
          <div className="field">
            <label htmlFor="taskDescription">Details (optional)</label>
            <textarea
              id="taskDescription"
              name="description"
              className="input"
              rows={2}
              maxLength={4000}
            />
          </div>
          <div className="field">
            <label htmlFor="taskPriority">Priority</label>
            <select id="taskPriority" name="priority" className="input" defaultValue="medium">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="taskDue">Due date (optional)</label>
            <input id="taskDue" name="dueDate" className="input" type="date" />
          </div>
          <button className="btn btn-secondary" type="submit">
            Add task
          </button>
        </form>
        <ul>
          {(tasks ?? []).map((t) => (
            <li key={t.id}>
              {t.title} · {t.status.replaceAll("_", " ")} · {t.priority}
              {t.due_at ? ` · due ${new Date(t.due_at).toLocaleDateString()}` : ""}
              {t.status === "open" || t.status === "in_progress" ? (
                <form action={completeTaskAction} style={{ display: "inline" }}>
                  <input type="hidden" name="recordId" value={record.id} />
                  <input type="hidden" name="taskId" value={t.id} />
                  <button
                    className="btn btn-secondary"
                    type="submit"
                    style={{ marginLeft: "var(--space-sm)" }}
                  >
                    Mark done
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Check-ins</h2>
        {(checkIns ?? []).length === 0 ? (
          <p>No check-ins yet.</p>
        ) : (
          <ul>
            {(checkIns ?? []).map((c) => (
              <li key={c.id}>
                {c.status.replaceAll("_", " ")} · due {new Date(c.due_at).toLocaleDateString()}
                {c.submission_id ? " · submitted" : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
