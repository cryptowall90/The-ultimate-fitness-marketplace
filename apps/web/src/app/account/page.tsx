import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { updateClientProfileSchema, updateProfileSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { publicMediaUrl } from "@/lib/media";
import { AvatarUpload } from "@/components/avatar-upload";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

async function updateProfileAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in");

  const profileInput = updateProfileSchema.safeParse({
    displayName: String(formData.get("displayName") ?? ""),
    bio: String(formData.get("bio") ?? ""),
  });
  const clientInput = updateClientProfileSchema.safeParse({
    fitnessGoals: String(formData.get("fitnessGoals") ?? ""),
    preferredTrainingStyle: String(formData.get("preferredTrainingStyle") ?? ""),
    generalAvailability: String(formData.get("generalAvailability") ?? ""),
  });
  if (!profileInput.success || !clientInput.success) {
    redirect("/account?error=validation");
  }

  // RLS restricts these updates to the signed-in user's own rows.
  await supabase
    .from("profiles")
    .update({ display_name: profileInput.data.displayName, bio: profileInput.data.bio })
    .eq("user_id", user.id);
  await supabase
    .from("client_profiles")
    .update({
      fitness_goals: clientInput.data.fitnessGoals,
      preferred_training_style: clientInput.data.preferredTrainingStyle,
      general_availability: clientInput.data.generalAvailability,
    })
    .eq("user_id", user.id);
  revalidatePath("/account");
  redirect("/account?saved=1");
}

async function signOutAction(): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/account");

  const params = await searchParams;
  const [{ data: profile }, { data: clientProfile }, { data: orders }, { data: favorites }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("display_name, bio, avatar_media_id")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("client_profiles")
        .select("fitness_goals, preferred_training_style, general_availability")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("orders")
        .select("id, status, amount_cents, currency, created_at")
        .eq("client_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10),
      // Own favorites joined with the trainer's public profile; RLS hides
      // trainers who have since gone private.
      supabase
        .from("favorites")
        .select("trainer_id, trainer_profiles!inner(slug, headline)")
        .eq("user_id", user.id)
        .not("trainer_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  // Resolve the avatar's public URL (owner-readable media row; public bucket).
  const { data: avatarMedia } = profile?.avatar_media_id
    ? await supabase
        .from("media_objects")
        .select("bucket, object_key, status")
        .eq("id", profile.avatar_media_id)
        .eq("status", "published")
        .maybeSingle()
    : { data: null };
  const avatarUrl = avatarMedia ? publicMediaUrl(avatarMedia.bucket, avatarMedia.object_key) : null;

  return (
    <div>
      <h1>Your account</h1>
      {params.saved === "1" && (
        <p className="notice" role="status">
          Profile saved.
        </p>
      )}
      {params.error === "validation" && (
        <p className="notice notice-error" role="alert">
          Some fields were invalid — changes were not saved.
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Profile</h2>
        <AvatarUpload currentUrl={avatarUrl} />
        <form action={updateProfileAction} className="form-stack">
          <div className="field">
            <label htmlFor="displayName">Display name</label>
            <input
              id="displayName"
              name="displayName"
              className="input"
              defaultValue={profile?.display_name ?? ""}
              maxLength={80}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="bio">Bio</label>
            <textarea
              id="bio"
              name="bio"
              className="input"
              rows={3}
              defaultValue={profile?.bio ?? ""}
              maxLength={4000}
            />
          </div>
          <div className="field">
            <label htmlFor="fitnessGoals">Fitness goals</label>
            <textarea
              id="fitnessGoals"
              name="fitnessGoals"
              className="input"
              rows={3}
              defaultValue={clientProfile?.fitness_goals ?? ""}
              maxLength={4000}
            />
          </div>
          <div className="field">
            <label htmlFor="preferredTrainingStyle">Preferred training style</label>
            <input
              id="preferredTrainingStyle"
              name="preferredTrainingStyle"
              className="input"
              defaultValue={clientProfile?.preferred_training_style ?? ""}
              maxLength={500}
            />
          </div>
          <div className="field">
            <label htmlFor="generalAvailability">General availability</label>
            <input
              id="generalAvailability"
              name="generalAvailability"
              className="input"
              defaultValue={clientProfile?.general_availability ?? ""}
              maxLength={1000}
              placeholder="e.g. weekday mornings, Sat anytime"
            />
          </div>
          <button className="btn btn-primary" type="submit">
            Save profile
          </button>
        </form>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Purchases</h2>
        <p>
          <a href="/coaching">Your coaching — notes, assignments and check-ins →</a>
        </p>
        {(orders ?? []).length === 0 ? (
          <p>No purchases yet.</p>
        ) : (
          <ul>
            {(orders ?? []).map((order) => (
              <li key={order.id}>
                <a href={`/purchases/${order.id}`}>
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: order.currency.toUpperCase(),
                  }).format(order.amount_cents / 100)}{" "}
                  — {order.status.replaceAll("_", " ")}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Saved trainers</h2>
        {(favorites ?? []).length === 0 ? (
          <p>No saved trainers yet — tap “Save trainer” on a profile you like.</p>
        ) : (
          <ul>
            {(favorites ?? []).map((f) => {
              const tp = Array.isArray(f.trainer_profiles)
                ? f.trainer_profiles[0]
                : f.trainer_profiles;
              return tp ? (
                <li key={f.trainer_id}>
                  <a href={`/trainers/${tp.slug}`}>{tp.headline || tp.slug}</a>
                </li>
              ) : null;
            })}
          </ul>
        )}
      </div>

      <form action={signOutAction}>
        <button className="btn btn-secondary" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}
