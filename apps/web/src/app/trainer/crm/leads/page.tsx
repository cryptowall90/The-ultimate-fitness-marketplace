import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { leadCreateSchema, leadStageUpdateSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

/**
 * Lead pipeline. Everything here is tenant-isolated by the leads_owner_all
 * RLS policy — server actions use the anon-key client with the trainer's
 * session, so the database enforces ownership on every operation.
 */

const STAGES = [
  "lead",
  "contacted",
  "consultation_scheduled",
  "awaiting_payment",
  "active_client",
  "paused",
  "completed",
  "canceled",
  "former_client",
] as const;

const OPEN_STAGES = new Set(["lead", "contacted", "consultation_scheduled", "awaiting_payment"]);

async function addLeadAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/crm/leads");

  const emailRaw = String(formData.get("email") ?? "").trim();
  const parsed = leadCreateSchema.safeParse({
    displayName: String(formData.get("displayName") ?? ""),
    ...(emailRaw ? { email: emailRaw } : {}),
    source: String(formData.get("source") ?? "manual"),
    notes: String(formData.get("notes") ?? ""),
  });
  if (!parsed.success) redirect("/trainer/crm/leads?error=validation");

  const { error } = await supabase.from("leads").insert({
    trainer_id: user.id,
    display_name: parsed.data.displayName,
    email: parsed.data.email ?? null,
    source: parsed.data.source,
    stage: parsed.data.stage,
    notes: parsed.data.notes,
  });
  if (error) redirect("/trainer/crm/leads?error=save");

  revalidatePath("/trainer/crm/leads");
  redirect("/trainer/crm/leads?saved=1");
}

async function moveLeadAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/crm/leads");

  const parsed = leadStageUpdateSchema.safeParse({
    leadId: String(formData.get("leadId") ?? ""),
    stage: String(formData.get("stage") ?? ""),
  });
  if (!parsed.success) redirect("/trainer/crm/leads?error=validation");

  await supabase
    .from("leads")
    .update({ stage: parsed.data.stage })
    .eq("id", parsed.data.leadId)
    .eq("trainer_id", user.id);
  revalidatePath("/trainer/crm/leads");
  redirect("/trainer/crm/leads?saved=1");
}

async function deleteLeadAction(formData: FormData): Promise<void> {
  "use server";
  const leadId = String(formData.get("leadId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(leadId)) notFound();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/crm/leads");

  await supabase.from("leads").delete().eq("id", leadId).eq("trainer_id", user.id);
  revalidatePath("/trainer/crm/leads");
  redirect("/trainer/crm/leads?saved=1");
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/crm/leads");

  const params = await searchParams;
  const [{ data: trainer }, { data: leads }] = await Promise.all([
    supabase
      .from("trainer_profiles")
      .select("application_status")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("leads")
      .select("id, display_name, email, source, stage, notes, created_at")
      .eq("trainer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (!trainer) {
    return (
      <div>
        <h1>Leads</h1>
        <div className="card">
          <p>
            The CRM is available once you have a trainer profile.{" "}
            <Link href="/trainer/apply">Apply to become a trainer</Link>.
          </p>
        </div>
      </div>
    );
  }

  const open = (leads ?? []).filter((l) => OPEN_STAGES.has(l.stage));
  const closed = (leads ?? []).filter((l) => !OPEN_STAGES.has(l.stage));

  const leadRow = (l: NonNullable<typeof leads>[number]) => (
    <div key={l.id} className="card" style={{ marginBottom: "var(--space-md)" }}>
      <p>
        <strong>{l.display_name}</strong>
        {l.email ? ` · ${l.email}` : ""} · via {l.source} ·{" "}
        {new Date(l.created_at).toLocaleDateString()}
      </p>
      {l.notes && <p style={{ whiteSpace: "pre-wrap" }}>{l.notes}</p>}
      <div style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" }}>
        <form action={moveLeadAction} style={{ display: "flex", gap: "var(--space-xs)" }}>
          <input type="hidden" name="leadId" value={l.id} />
          <label htmlFor={`stage-${l.id}`} className="visually-hidden">
            Stage
          </label>
          <select id={`stage-${l.id}`} name="stage" className="input" defaultValue={l.stage}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <button className="btn btn-secondary" type="submit">
            Move
          </button>
        </form>
        <form action={deleteLeadAction}>
          <input type="hidden" name="leadId" value={l.id} />
          <button className="btn btn-secondary" type="submit">
            Delete
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div>
      <p>
        <Link href="/trainer/crm">← CRM</Link>
      </p>
      <h1>Leads</h1>

      {params.saved === "1" && (
        <p className="notice" role="status">
          Saved.
        </p>
      )}
      {params.error === "validation" && (
        <p className="notice notice-error" role="alert">
          Check the name (required) and email format.
        </p>
      )}
      {params.error === "save" && (
        <p className="notice notice-error" role="alert">
          The lead could not be saved. Please try again.
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Add a lead</h2>
        <form action={addLeadAction} className="form-stack">
          <div className="field">
            <label htmlFor="displayName">Name</label>
            <input id="displayName" name="displayName" className="input" maxLength={120} required />
          </div>
          <div className="field">
            <label htmlFor="email">Email (optional)</label>
            <input id="email" name="email" className="input" type="email" maxLength={254} />
          </div>
          <div className="field">
            <label htmlFor="source">Source</label>
            <select id="source" name="source" className="input" defaultValue="manual">
              <option value="manual">Manual</option>
              <option value="inquiry">Inquiry</option>
              <option value="referral">Referral</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="notes">Notes (optional)</label>
            <textarea id="notes" name="notes" className="input" rows={2} maxLength={4000} />
          </div>
          <button className="btn btn-primary" type="submit">
            Add lead
          </button>
        </form>
      </div>

      <h2>Open pipeline ({open.length})</h2>
      {open.length === 0 ? <p>No open leads.</p> : open.map(leadRow)}

      <h2>Closed ({closed.length})</h2>
      {closed.length === 0 ? <p>Nothing closed yet.</p> : closed.map(leadRow)}
    </div>
  );
}
