import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { programStatusTransitionSchema, programUpdateSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { programFieldsFromForm } from "../program-form";
import { ProgramFormFields, type ProgramDefaults } from "../program-form-fields";

export const metadata: Metadata = { title: "Edit program" };
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/;

async function updateProgramAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/programs");

  const programId = String(formData.get("programId") ?? "");
  if (!UUID_RE.test(programId)) notFound();

  const parsed = programUpdateSchema.safeParse(programFieldsFromForm(formData));
  if (!parsed.success) redirect(`/trainer/programs/${programId}?error=validation`);

  // RLS restricts the read and the write to the owner's own program.
  const { data: current } = await supabase
    .from("programs")
    .select("status, version")
    .eq("id", programId)
    .eq("trainer_id", user.id)
    .maybeSingle();
  if (!current) notFound();
  if (current.status === "archived") {
    redirect(`/trainer/programs/${programId}?error=archived`);
  }

  const { error } = await supabase
    .from("programs")
    .update({
      slug: parsed.data.slug,
      title: parsed.data.title,
      summary: parsed.data.summary,
      full_description: parsed.data.fullDescription,
      delivery_mode: parsed.data.deliveryMode,
      pricing_type: parsed.data.pricingType,
      price_cents: parsed.data.priceCents,
      duration_value: parsed.data.durationValue,
      duration_unit: parsed.data.durationUnit,
      recurrence_interval: parsed.data.recurrenceInterval ?? null,
      recurrence_interval_count: parsed.data.recurrenceIntervalCount ?? null,
      capacity: parsed.data.capacity ?? null,
      approval_policy: parsed.data.approvalPolicy,
      included_features: parsed.data.includedFeatures,
      cancellation_terms: parsed.data.cancellationTerms,
      refund_policy: parsed.data.refundPolicy,
      visibility: parsed.data.visibility,
      // Editing a live program creates a new immutable version snapshot;
      // buyers always get the version that was current at purchase time.
      ...(current.status === "published" ? { version: current.version + 1 } : {}),
    })
    .eq("id", programId)
    .eq("trainer_id", user.id);
  if (error) redirect(`/trainer/programs/${programId}?error=save`);

  revalidatePath(`/trainer/programs/${programId}`);
  redirect(`/trainer/programs/${programId}?saved=1`);
}

async function transitionProgramAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/programs");

  const programId = String(formData.get("programId") ?? "");
  if (!UUID_RE.test(programId)) notFound();
  const parsed = programStatusTransitionSchema.safeParse({
    to: String(formData.get("to") ?? ""),
  });
  if (!parsed.success) redirect(`/trainer/programs/${programId}?error=transition`);

  // The database state machine validates the transition and snapshots the
  // published version; RLS limits this to the owner.
  const { error } = await supabase
    .from("programs")
    .update({ status: parsed.data.to })
    .eq("id", programId)
    .eq("trainer_id", user.id);
  if (error) redirect(`/trainer/programs/${programId}?error=transition`);

  revalidatePath(`/trainer/programs/${programId}`);
  redirect(`/trainer/programs/${programId}?saved=1`);
}

const TRANSITIONS: Record<string, Array<{ to: string; label: string; kind: string }>> = {
  draft: [{ to: "published", label: "Publish program", kind: "btn-primary" }],
  published: [
    { to: "paused", label: "Pause sales", kind: "btn-secondary" },
    { to: "archived", label: "Archive", kind: "btn-secondary" },
  ],
  paused: [
    { to: "published", label: "Resume sales", kind: "btn-primary" },
    { to: "archived", label: "Archive", kind: "btn-secondary" },
  ],
  archived: [],
};

export default async function EditProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId } = await params;
  if (!UUID_RE.test(programId)) notFound();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/trainer/programs/${programId}`);

  const query = await searchParams;
  const { data: program } = await supabase
    .from("programs")
    .select(
      "id, slug, title, summary, full_description, delivery_mode, pricing_type, price_cents, currency, duration_value, duration_unit, recurrence_interval, recurrence_interval_count, capacity, approval_policy, included_features, cancellation_terms, refund_policy, visibility, status, version",
    )
    .eq("id", programId)
    .eq("trainer_id", user.id)
    .maybeSingle();
  if (!program) notFound();

  const transitions = TRANSITIONS[program.status] ?? [];

  return (
    <div>
      <h1>{program.title}</h1>
      <p>
        Status: <strong>{program.status}</strong> · Version {program.version} ·{" "}
        <Link href="/trainer/programs">Back to programs</Link>
      </p>

      {query.saved === "1" && (
        <p className="notice" role="status">
          Program updated.
        </p>
      )}
      {query.error === "validation" && (
        <p className="notice notice-error" role="alert">
          Some fields were invalid — check the price, duration and required text fields.
        </p>
      )}
      {query.error === "save" && (
        <p className="notice notice-error" role="alert">
          The program could not be saved. The program URL may already be in use.
        </p>
      )}
      {query.error === "transition" && (
        <p className="notice notice-error" role="alert">
          That status change is not allowed from the program’s current state.
        </p>
      )}
      {query.error === "archived" && (
        <p className="notice notice-error" role="alert">
          Archived programs can no longer be edited.
        </p>
      )}

      {transitions.length > 0 && (
        <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
          <h2>Availability</h2>
          {program.status === "draft" && (
            <p>Publishing makes this program purchasable and captures an immutable snapshot.</p>
          )}
          <div style={{ display: "flex", gap: "var(--space-sm)" }}>
            {transitions.map((t) => (
              <form key={t.to} action={transitionProgramAction}>
                <input type="hidden" name="programId" value={program.id} />
                <input type="hidden" name="to" value={t.to} />
                <button className={`btn ${t.kind}`} type="submit">
                  {t.label}
                </button>
              </form>
            ))}
          </div>
        </div>
      )}

      {program.status !== "archived" ? (
        <div className="card">
          <h2>Program details</h2>
          {program.status === "published" && (
            <p>
              This program is live — saving changes creates version {program.version + 1}. Existing
              clients keep the version they purchased.
            </p>
          )}
          <form action={updateProgramAction} className="form-stack">
            <input type="hidden" name="programId" value={program.id} />
            <ProgramFormFields defaults={program as ProgramDefaults} />
            <button className="btn btn-primary" type="submit">
              Save changes
            </button>
          </form>
        </div>
      ) : (
        <p>This program is archived and read-only.</p>
      )}
    </div>
  );
}
