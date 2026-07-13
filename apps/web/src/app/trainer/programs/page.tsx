import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { programCreateSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { programFieldsFromForm } from "./program-form";
import { ProgramFormFields } from "./program-form-fields";

export const metadata: Metadata = { title: "Your programs" };
export const dynamic = "force-dynamic";

async function createProgramAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/programs");

  const parsed = programCreateSchema.safeParse(programFieldsFromForm(formData));
  if (!parsed.success) redirect("/trainer/programs?error=validation");

  // RLS: owners may only insert their own programs; drafts are never public.
  const { error } = await supabase.from("programs").insert({
    trainer_id: user.id,
    slug: parsed.data.slug,
    title: parsed.data.title,
    summary: parsed.data.summary,
    full_description: parsed.data.fullDescription,
    delivery_mode: parsed.data.deliveryMode,
    pricing_type: parsed.data.pricingType,
    price_cents: parsed.data.priceCents,
    currency: parsed.data.currency,
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
  });
  if (error) redirect("/trainer/programs?error=save");

  revalidatePath("/trainer/programs");
  redirect("/trainer/programs?saved=1");
}

export default async function TrainerProgramsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/programs");

  const params = await searchParams;
  const [{ data: trainer }, { data: programs }] = await Promise.all([
    supabase
      .from("trainer_profiles")
      .select("application_status")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("programs")
      .select("id, slug, title, status, price_cents, currency, updated_at")
      .eq("trainer_id", user.id)
      .order("updated_at", { ascending: false }),
  ]);

  if (trainer?.application_status !== "approved") {
    return (
      <div>
        <h1>Your programs</h1>
        <div className="card">
          <p>
            Programs can be created once your trainer application is approved.{" "}
            <Link href="/trainer/apply">Check your application status</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Your programs</h1>
      <p>
        <Link href="/trainer/crm">CRM</Link> · <Link href="/trainer/locations">Locations</Link> ·{" "}
        <Link href="/trainer/settings/billing">Billing</Link> ·{" "}
        <Link href="/trainer/settings/payouts">Payouts</Link>
      </p>

      {params.saved === "1" && (
        <p className="notice" role="status">
          Program saved.
        </p>
      )}
      {params.error === "validation" && (
        <p className="notice notice-error" role="alert">
          Some fields were invalid — check the price, duration and required text fields.
        </p>
      )}
      {params.error === "save" && (
        <p className="notice notice-error" role="alert">
          The program could not be saved. The program URL may already be in use.
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Programs</h2>
        {(programs ?? []).length === 0 ? (
          <p>No programs yet — create your first one below.</p>
        ) : (
          <ul>
            {(programs ?? []).map((p) => (
              <li key={p.id}>
                <Link href={`/trainer/programs/${p.id}`}>{p.title}</Link> —{" "}
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: p.currency.toUpperCase(),
                }).format(p.price_cents / 100)}{" "}
                · {p.status}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Create a program</h2>
        <form action={createProgramAction} className="form-stack">
          <ProgramFormFields />
          <button className="btn btn-primary" type="submit">
            Save draft
          </button>
        </form>
        <p>New programs start as drafts — publish them from the program page when they’re ready.</p>
      </div>
    </div>
  );
}
