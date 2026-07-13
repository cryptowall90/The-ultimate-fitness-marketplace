import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { credentialSchema, trainerApplicationSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DocumentUpload } from "@/components/document-upload";

export const metadata: Metadata = { title: "Become a trainer" };
export const dynamic = "force-dynamic";

/**
 * Trainer application: the owner drafts a trainer profile, attaches
 * credentials, and submits it for review. RLS is the authorization boundary —
 * owners can only insert/update their own rows, and the database trigger
 * only permits the draft → submitted status transition from here. Approval
 * happens in services/api (see /admin/trainer-applications).
 */

function parseLanguages(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 10);
}

async function saveApplicationAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/apply");

  const yearsRaw = String(formData.get("yearsExperience") ?? "");
  const businessName = String(formData.get("businessName") ?? "").trim();
  const parsed = trainerApplicationSchema.safeParse({
    slug: String(formData.get("slug") ?? ""),
    headline: String(formData.get("headline") ?? ""),
    about: String(formData.get("about") ?? ""),
    serviceMode: String(formData.get("serviceMode") ?? ""),
    yearsExperience: yearsRaw === "" ? NaN : Number(yearsRaw),
    languages: parseLanguages(String(formData.get("languages") ?? "")),
    ...(businessName ? { businessName } : {}),
    specialtyIds: formData.getAll("specialtyIds").map(String),
  });
  if (!parsed.success) {
    redirect("/trainer/apply?error=validation");
  }

  // Owner-scoped upsert; RLS rejects any other user_id.
  const { error: profileError } = await supabase.from("trainer_profiles").upsert(
    {
      user_id: user.id,
      slug: parsed.data.slug,
      headline: parsed.data.headline,
      about: parsed.data.about,
      service_mode: parsed.data.serviceMode,
      years_experience: parsed.data.yearsExperience,
      languages: parsed.data.languages,
      business_name: parsed.data.businessName ?? null,
    },
    { onConflict: "user_id" },
  );
  if (profileError) {
    // Most likely a taken slug (unique) — uniform message, no internals.
    redirect("/trainer/apply?error=save");
  }

  await supabase.from("trainer_specialties").delete().eq("trainer_id", user.id);
  const { error: specialtiesError } = await supabase.from("trainer_specialties").insert(
    parsed.data.specialtyIds.map((specialtyId) => ({
      trainer_id: user.id,
      specialty_id: specialtyId,
    })),
  );
  if (specialtiesError) redirect("/trainer/apply?error=save");

  revalidatePath("/trainer/apply");
  redirect("/trainer/apply?saved=1");
}

async function addCredentialAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/apply");

  const issuedAt = String(formData.get("issuedAt") ?? "");
  const expiresAt = String(formData.get("expiresAt") ?? "");
  const documentMediaId = String(formData.get("documentMediaId") ?? "");
  const parsed = credentialSchema.safeParse({
    title: String(formData.get("title") ?? ""),
    issuingOrganization: String(formData.get("issuingOrganization") ?? ""),
    ...(issuedAt ? { issuedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(documentMediaId ? { documentMediaId } : {}),
  });
  if (!parsed.success) redirect("/trainer/apply?error=credential");

  // The media id is client-supplied — verify it is the caller's own
  // credential document before attaching it (the FK alone wouldn't).
  if (parsed.data.documentMediaId) {
    const { data: media } = await supabase
      .from("media_objects")
      .select("id")
      .eq("id", parsed.data.documentMediaId)
      .eq("owner_id", user.id)
      .eq("visibility", "private_document")
      .maybeSingle();
    if (!media) redirect("/trainer/apply?error=credential");
  }

  const { error } = await supabase.from("trainer_credentials").insert({
    trainer_id: user.id,
    title: parsed.data.title,
    issuing_organization: parsed.data.issuingOrganization,
    issued_at: parsed.data.issuedAt ?? null,
    expires_at: parsed.data.expiresAt ?? null,
    document_media_id: parsed.data.documentMediaId ?? null,
  });
  if (error) redirect("/trainer/apply?error=credential");

  revalidatePath("/trainer/apply");
  redirect("/trainer/apply?saved=1");
}

async function submitApplicationAction(): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/apply");

  // The DB trigger only allows the owner to move draft → submitted; the
  // status filter keeps the update a no-op for any other state.
  const { error } = await supabase
    .from("trainer_profiles")
    .update({ application_status: "submitted" })
    .eq("user_id", user.id)
    .eq("application_status", "draft");
  if (error) redirect("/trainer/apply?error=submit");

  revalidatePath("/trainer/apply");
  redirect("/trainer/apply?submitted=1");
}

export default async function TrainerApplyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/apply");

  const params = await searchParams;
  const [
    { data: profile },
    { data: specialties },
    { data: ownSpecialties },
    { data: credentials },
  ] = await Promise.all([
    supabase
      .from("trainer_profiles")
      .select(
        "slug, headline, about, service_mode, years_experience, languages, business_name, application_status, application_submitted_at, rejection_reason",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("specialties").select("id, name").eq("is_active", true).order("name"),
    supabase.from("trainer_specialties").select("specialty_id").eq("trainer_id", user.id),
    supabase
      .from("trainer_credentials")
      .select("id, title, issuing_organization, issued_at, status")
      .eq("trainer_id", user.id)
      .order("created_at"),
  ]);

  const status = profile?.application_status ?? "none";
  const ownSpecialtyIds = new Set((ownSpecialties ?? []).map((s) => s.specialty_id));
  const editable = status === "none" || status === "draft";

  return (
    <div>
      <h1>Become a trainer</h1>

      {params.saved === "1" && (
        <p className="notice" role="status">
          Application saved.
        </p>
      )}
      {params.submitted === "1" && (
        <p className="notice" role="status">
          Application submitted — we’ll review it and get back to you.
        </p>
      )}
      {params.error === "validation" && (
        <p className="notice notice-error" role="alert">
          Some fields were invalid — check that your headline (10+ characters), about section (50+
          characters), languages and at least one specialty are filled in.
        </p>
      )}
      {params.error === "save" && (
        <p className="notice notice-error" role="alert">
          Your application could not be saved. The profile URL may already be taken.
        </p>
      )}
      {params.error === "credential" && (
        <p className="notice notice-error" role="alert">
          The credential could not be added — check the fields and try again.
        </p>
      )}
      {params.error === "submit" && (
        <p className="notice notice-error" role="alert">
          The application could not be submitted. Save it first, then try again.
        </p>
      )}

      {status === "submitted" || status === "under_review" ? (
        <div className="card">
          <h2>Application under review</h2>
          <p>
            Your application is being reviewed. You’ll be able to publish your profile as soon as
            it’s approved.
          </p>
        </div>
      ) : null}

      {status === "approved" ? (
        <div className="card">
          <h2>You’re approved 🎉</h2>
          <p>
            Your trainer profile is live
            {profile?.slug ? (
              <>
                {" — "}
                <a href={`/trainers/${profile.slug}`}>view it here</a>
              </>
            ) : null}
            .
          </p>
        </div>
      ) : null}

      {status === "rejected" ? (
        <div className="card">
          <h2>Application not approved</h2>
          <p>
            {profile?.rejection_reason
              ? `Reason: ${profile.rejection_reason}`
              : "Your application was not approved."}{" "}
            Contact support if you believe this is a mistake.
          </p>
        </div>
      ) : null}

      {editable ? (
        <>
          <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
            <h2>Your trainer profile</h2>
            <form action={saveApplicationAction} className="form-stack">
              <div className="field">
                <label htmlFor="slug">Profile URL</label>
                <input
                  id="slug"
                  name="slug"
                  className="input"
                  defaultValue={profile?.slug ?? ""}
                  pattern="[a-z0-9][a-z0-9-]{1,60}"
                  title="Lowercase letters, numbers and hyphens"
                  placeholder="e.g. jane-strength"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="headline">Headline</label>
                <input
                  id="headline"
                  name="headline"
                  className="input"
                  defaultValue={profile?.headline ?? ""}
                  minLength={10}
                  maxLength={140}
                  placeholder="e.g. Strength coaching for busy professionals"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="about">About you</label>
                <textarea
                  id="about"
                  name="about"
                  className="input"
                  rows={6}
                  defaultValue={profile?.about ?? ""}
                  minLength={50}
                  maxLength={8000}
                  placeholder="Your coaching approach, experience and who you help best (50+ characters)"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="serviceMode">How do you train clients?</label>
                <select
                  id="serviceMode"
                  name="serviceMode"
                  className="input"
                  defaultValue={profile?.service_mode ?? "online"}
                >
                  <option value="online">Online</option>
                  <option value="in_person">In person</option>
                  <option value="hybrid">Both</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="yearsExperience">Years of experience</label>
                <input
                  id="yearsExperience"
                  name="yearsExperience"
                  className="input"
                  type="number"
                  min={0}
                  max={80}
                  defaultValue={profile?.years_experience ?? ""}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="languages">Languages (comma-separated)</label>
                <input
                  id="languages"
                  name="languages"
                  className="input"
                  defaultValue={(profile?.languages ?? []).join(", ")}
                  placeholder="e.g. English, Spanish"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="businessName">Business name (optional)</label>
                <input
                  id="businessName"
                  name="businessName"
                  className="input"
                  defaultValue={profile?.business_name ?? ""}
                  maxLength={200}
                />
              </div>
              <fieldset className="field">
                <legend>Specialties (pick 1–10)</legend>
                {(specialties ?? []).map((s) => (
                  <label key={s.id} style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      name="specialtyIds"
                      value={s.id}
                      defaultChecked={ownSpecialtyIds.has(s.id)}
                    />{" "}
                    {s.name}
                  </label>
                ))}
                {(specialties ?? []).length === 0 && <p>No specialties are configured yet.</p>}
              </fieldset>
              <button className="btn btn-primary" type="submit">
                Save application
              </button>
            </form>
          </div>

          <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
            <h2>Credentials</h2>
            {(credentials ?? []).length === 0 ? (
              <p>No credentials added yet. Adding at least one speeds up review.</p>
            ) : (
              <ul>
                {(credentials ?? []).map((c) => (
                  <li key={c.id}>
                    {c.title} — {c.issuing_organization}
                    {c.issued_at ? ` (issued ${c.issued_at})` : ""} · {c.status}
                  </li>
                ))}
              </ul>
            )}
            <form action={addCredentialAction} className="form-stack">
              <div className="field">
                <label htmlFor="credTitle">Credential</label>
                <input
                  id="credTitle"
                  name="title"
                  className="input"
                  minLength={2}
                  maxLength={200}
                  placeholder="e.g. Certified Personal Trainer"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="credOrg">Issuing organization</label>
                <input
                  id="credOrg"
                  name="issuingOrganization"
                  className="input"
                  minLength={2}
                  maxLength={200}
                  placeholder="e.g. NASM"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="credIssued">Issued on (optional)</label>
                <input id="credIssued" name="issuedAt" className="input" type="date" />
              </div>
              <div className="field">
                <label htmlFor="credExpires">Expires on (optional)</label>
                <input id="credExpires" name="expiresAt" className="input" type="date" />
              </div>
              <DocumentUpload name="documentMediaId" />
              <button className="btn btn-secondary" type="submit">
                Add credential
              </button>
            </form>
          </div>

          {status === "draft" ? (
            <div className="card">
              <h2>Submit for review</h2>
              <p>
                Once submitted you won’t be able to edit the application until a decision is made.
              </p>
              <form action={submitApplicationAction}>
                <button className="btn btn-primary" type="submit">
                  Submit application
                </button>
              </form>
            </div>
          ) : (
            <p>Save your profile first — you can submit it for review afterwards.</p>
          )}
        </>
      ) : null}
    </div>
  );
}
