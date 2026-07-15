import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { trainerApplicationDecisionSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Trainer applications" };
export const dynamic = "force-dynamic";

/**
 * Admin review UI. This page is a thin client of services/api: approval is a
 * privileged transition (database trigger blocks it outside service context),
 * so the decision endpoint re-checks the admin role server-side and writes the
 * admin_actions audit row. The role check here is routing UX, not security.
 */

interface ApplicationListItem {
  trainerId: string;
  displayName: string;
  slug: string | null;
  headline: string;
  about: string;
  serviceMode: string;
  yearsExperience: number | null;
  languages: string[];
  businessName: string | null;
  submittedAt: string | null;
  specialties: string[];
  credentials: { title: string; issuingOrganization: string; status: string }[];
}

async function requireAdminSession() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/admin/trainers");
  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  // Uniform 404 for non-admins: the page's existence is not advertised.
  if (!adminRole) notFound();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect("/auth/sign-in?next=/admin/trainers");
  return { accessToken: session.access_token };
}

async function decideApplicationAction(formData: FormData): Promise<void> {
  "use server";
  const { accessToken } = await requireAdminSession();

  const parsed = trainerApplicationDecisionSchema.safeParse({
    trainerId: String(formData.get("trainerId") ?? ""),
    decision: String(formData.get("decision") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  });
  if (!parsed.success) {
    redirect("/admin/trainers?error=validation");
  }

  const res = await fetch(
    `${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/admin/trainer-applications/decision`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    redirect(`/admin/trainers?error=${res.status === 409 ? "conflict" : "failed"}`);
  }
  revalidatePath("/admin/trainers");
  redirect(`/admin/trainers?decided=${parsed.data.decision}`);
}

const NOTICES: Record<string, { kind: "ok" | "error"; text: string }> = {
  approved: { kind: "ok", text: "Application approved — the trainer profile is now live." },
  rejected: { kind: "ok", text: "Application rejected — the applicant can see the reason." },
  validation: { kind: "error", text: "A decision needs a reason of at least 3 characters." },
  conflict: { kind: "error", text: "This application was already decided." },
  failed: { kind: "error", text: "The decision could not be recorded. Please try again." },
};

export default async function AdminTrainersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { accessToken } = await requireAdminSession();
  const params = await searchParams;

  const res = await fetch(
    `${publicEnv().NEXT_PUBLIC_API_BASE_URL}/v1/admin/trainer-applications?status=submitted`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  if (!res.ok) {
    return (
      <div>
        <h1>Trainer applications</h1>
        <p className="notice notice-error" role="alert">
          Applications could not be loaded. Please retry.
        </p>
      </div>
    );
  }
  const { applications } = (await res.json()) as { applications: ApplicationListItem[] };

  const noticeKey =
    typeof params.decided === "string"
      ? params.decided
      : typeof params.error === "string"
        ? params.error
        : null;
  const notice = noticeKey ? NOTICES[noticeKey] : undefined;

  return (
    <div>
      <h1>Trainer applications</h1>
      {notice && (
        <p
          className={notice.kind === "error" ? "notice notice-error" : "notice"}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}

      {applications.length === 0 ? (
        <div className="card">
          <p>No applications waiting for review. 🎉</p>
        </div>
      ) : (
        applications.map((application) => (
          <div
            key={application.trainerId}
            className="card"
            style={{ marginBottom: "var(--space-lg)" }}
          >
            <h2>{application.displayName || "Unnamed applicant"}</h2>
            <p>
              <strong>{application.headline}</strong>
            </p>
            <p>{application.about}</p>
            <ul>
              <li>Profile URL: {application.slug ?? "—"}</li>
              <li>Service mode: {application.serviceMode.replaceAll("_", " ")}</li>
              <li>Experience: {application.yearsExperience ?? "—"} years</li>
              <li>Languages: {application.languages.join(", ") || "—"}</li>
              <li>Specialties: {application.specialties.join(", ") || "—"}</li>
              {application.businessName && <li>Business: {application.businessName}</li>}
              <li>
                Submitted:{" "}
                {application.submittedAt
                  ? new Date(application.submittedAt).toLocaleString("en-US")
                  : "—"}
              </li>
            </ul>
            {application.credentials.length > 0 && (
              <>
                <h3>Credentials</h3>
                <ul>
                  {application.credentials.map((credential, i) => (
                    <li key={i}>
                      {credential.title} — {credential.issuingOrganization} ({credential.status})
                    </li>
                  ))}
                </ul>
              </>
            )}
            <form action={decideApplicationAction} className="form-stack">
              <input type="hidden" name="trainerId" value={application.trainerId} />
              <div className="field">
                <label htmlFor={`reason-${application.trainerId}`}>
                  Decision reason (recorded in the audit log; shown to the applicant on rejection)
                </label>
                <textarea
                  id={`reason-${application.trainerId}`}
                  name="reason"
                  className="input"
                  rows={2}
                  minLength={3}
                  maxLength={2000}
                  required
                />
              </div>
              <div style={{ display: "flex", gap: "var(--space-sm)" }}>
                <button className="btn btn-primary" type="submit" name="decision" value="approved">
                  Approve
                </button>
                <button
                  className="btn btn-secondary"
                  type="submit"
                  name="decision"
                  value="rejected"
                >
                  Reject
                </button>
              </div>
            </form>
          </div>
        ))
      )}
    </div>
  );
}
