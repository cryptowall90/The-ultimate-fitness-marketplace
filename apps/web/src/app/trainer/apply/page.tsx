import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { trainerApplicationSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Become a trainer" };
export const dynamic = "force-dynamic";

function parseApplicationForm(formData: FormData) {
  const languages = String(formData.get("languages") ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 10);
  const businessName = String(formData.get("businessName") ?? "").trim();
  return trainerApplicationSchema.safeParse({
    slug: String(formData.get("slug") ?? ""),
    headline: String(formData.get("headline") ?? ""),
    about: String(formData.get("about") ?? ""),
    serviceMode: String(formData.get("serviceMode") ?? ""),
    yearsExperience: Number(formData.get("yearsExperience") ?? Number.NaN),
    languages,
    ...(businessName ? { businessName } : {}),
    specialtyIds: formData.getAll("specialtyIds").map(String),
  });
}

async function saveApplicationAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/apply");

  const parsed = parseApplicationForm(formData);
  if (!parsed.success) {
    redirect("/trainer/apply?error=validation");
  }

  const { data: existing } = await supabase
    .from("trainer_profiles")
    .select("application_status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing && existing.application_status !== "draft") {
    redirect("/trainer/apply?error=not_editable");
  }

  const profileRow = {
    slug: parsed.data.slug,
    headline: parsed.data.headline,
    about: parsed.data.about,
    service_mode: parsed.data.serviceMode,
    years_experience: parsed.data.yearsExperience,
    languages: parsed.data.languages,
    business_name: parsed.data.businessName ?? null,
  };
  // RLS: insert/update permitted on the caller's own row only.
  const { error } = existing
    ? await supabase.from("trainer_profiles").update(profileRow).eq("user_id", user.id)
    : await supabase.from("trainer_profiles").insert({ ...profileRow, user_id: user.id });
  if (error) {
    redirect(
      error.code === "23505"
        ? "/trainer/apply?error=slug_taken"
        : "/trainer/apply?error=save_failed",
    );
  }

  // Replace specialty selection (owner-scoped by RLS).
  await supabase.from("trainer_specialties").delete().eq("trainer_id", user.id);
  const { error: specialtyError } = await supabase.from("trainer_specialties").insert(
    parsed.data.specialtyIds.map((specialtyId) => ({
      trainer_id: user.id,
      specialty_id: specialtyId,
    })),
  );
  if (specialtyError) {
    redirect("/trainer/apply?error=save_failed");
  }
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

  const [{ data: profile }, { data: specialties }] = await Promise.all([
    supabase
      .from("trainer_profiles")
      .select(
        "slug, headline, about, service_mode, years_experience, languages, business_name, application_status",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("trainer_specialties").select("specialty_id").eq("trainer_id", user.id),
  ]);
  if (!profile || profile.application_status !== "draft") {
    redirect("/trainer/apply?error=not_editable");
  }
  const complete = trainerApplicationSchema.safeParse({
    slug: profile.slug ?? "",
    headline: profile.headline,
    about: profile.about,
    serviceMode: profile.service_mode,
    yearsExperience: profile.years_experience ?? Number.NaN,
    languages: profile.languages ?? [],
    ...(profile.business_name ? { businessName: profile.business_name } : {}),
    specialtyIds: (specialties ?? []).map((s) => s.specialty_id),
  });
  if (!complete.success) {
    redirect("/trainer/apply?error=incomplete");
  }

  // The database trigger only permits the owner transition draft → submitted;
  // approval columns stay platform-managed.
  const { error } = await supabase
    .from("trainer_profiles")
    .update({ application_status: "submitted" })
    .eq("user_id", user.id)
    .eq("application_status", "draft");
  if (error) {
    redirect("/trainer/apply?error=save_failed");
  }
  revalidatePath("/trainer/apply");
  redirect("/trainer/apply?submitted=1");
}

const ERROR_MESSAGES: Record<string, string> = {
  validation: "Some fields were invalid — please review the highlighted requirements.",
  slug_taken: "That profile URL is already taken. Please choose another.",
  save_failed: "Your changes could not be saved. Please try again.",
  not_editable: "This application can no longer be edited.",
  incomplete:
    "Your application is incomplete. Fill in every required field (headline ≥ 10 characters, about ≥ 50 characters, at least one language and one specialty) and save before submitting.",
};

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
  const [{ data: profile }, { data: allSpecialties }, { data: ownSpecialties }] = await Promise.all(
    [
      supabase
        .from("trainer_profiles")
        .select(
          "slug, headline, about, service_mode, years_experience, languages, business_name, application_status, application_submitted_at, rejection_reason",
        )
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase.from("specialties").select("id, name").eq("is_active", true).order("name"),
      supabase.from("trainer_specialties").select("specialty_id").eq("trainer_id", user.id),
    ],
  );

  const status = profile?.application_status ?? "none";
  const selectedSpecialties = new Set((ownSpecialties ?? []).map((s) => s.specialty_id));
  const errorKey = typeof params.error === "string" ? params.error : null;

  if (status === "submitted" || status === "under_review") {
    return (
      <div>
        <h1>Trainer application</h1>
        <div className="card">
          <h2>Application under review</h2>
          <p>
            Thanks — your application was submitted
            {profile?.application_submitted_at
              ? ` on ${new Date(profile.application_submitted_at).toLocaleDateString("en-US")}`
              : ""}
            . Our team reviews every application; you will hear from us by email.
          </p>
        </div>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div>
        <h1>Trainer application</h1>
        <div className="card">
          <h2>You&apos;re approved 🎉</h2>
          <p>Your trainer profile is live.</p>
          {profile?.slug && (
            <p>
              <Link className="btn btn-primary" href={`/trainers/${profile.slug}`}>
                View your public profile
              </Link>
            </p>
          )}
        </div>
      </div>
    );
  }

  if (status === "rejected" || status === "suspended") {
    return (
      <div>
        <h1>Trainer application</h1>
        <div className="card">
          <h2>{status === "rejected" ? "Application not approved" : "Profile suspended"}</h2>
          {profile?.rejection_reason && <p>Reason: {profile.rejection_reason}</p>}
          <p>If you believe this is a mistake, contact support and we will take another look.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Become a trainer</h1>
      <p>
        Tell clients who you are and how you coach. Submissions are reviewed by our team before your
        profile goes live.
      </p>

      {params.saved === "1" && (
        <p className="notice" role="status">
          Draft saved.
        </p>
      )}
      {errorKey && ERROR_MESSAGES[errorKey] && (
        <p className="notice notice-error" role="alert">
          {ERROR_MESSAGES[errorKey]}
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
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
              placeholder="e.g. jordan-strength"
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
              placeholder="Strength coaching for busy parents"
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
              placeholder="Your coaching philosophy, experience and what clients can expect (at least 50 characters)."
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
              <option value="hybrid">Online and in person</option>
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
              defaultValue={profile?.years_experience ?? 0}
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
              placeholder="English, Spanish"
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
            <legend>Specialties (pick at least one)</legend>
            {(allSpecialties ?? []).map((specialty) => (
              <label key={specialty.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  name="specialtyIds"
                  value={specialty.id}
                  defaultChecked={selectedSpecialties.has(specialty.id)}
                />{" "}
                {specialty.name}
              </label>
            ))}
          </fieldset>
          <button className="btn btn-primary" type="submit">
            Save draft
          </button>
        </form>
      </div>

      {status === "draft" && (
        <div className="card">
          <h2>Ready?</h2>
          <p>
            Submitting sends your saved draft to our review team. You will not be able to edit it
            while it is under review.
          </p>
          <form action={submitApplicationAction}>
            <button className="btn btn-secondary" type="submit">
              Submit application for review
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
