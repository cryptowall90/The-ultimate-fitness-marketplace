import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { publicMediaUrl } from "@/lib/media";
import { BuyProgramButton } from "./buy-button";

export const dynamic = "force-dynamic";

async function toggleFavoriteAction(formData: FormData): Promise<void> {
  "use server";
  const slug = String(formData.get("slug") ?? "");
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) notFound();
  const trainerId = String(formData.get("trainerId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(trainerId)) notFound();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/trainers/${slug}`);

  // RLS: users manage only their own favorites rows.
  if (formData.get("favorited") === "1") {
    await supabase.from("favorites").delete().eq("user_id", user.id).eq("trainer_id", trainerId);
  } else {
    await supabase.from("favorites").insert({ user_id: user.id, trainer_id: trainerId });
  }
  revalidatePath(`/trainers/${slug}`);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Trainer ${slug}` };
}

export default async function TrainerProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) notFound();

  const supabase = await createSupabaseServerClient();
  // RLS permits reading only public approved trainer profiles here.
  const { data: trainer } = await supabase
    .from("trainer_profiles")
    .select("user_id, slug, headline, about, service_mode, years_experience, languages")
    .eq("slug", slug)
    .maybeSingle();
  if (!trainer) notFound();

  const [
    { data: profile },
    { data: rating },
    { data: programs },
    { data: reviews },
    { data: locations },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("display_name, bio, avatar_media_id")
      .eq("user_id", trainer.user_id)
      .maybeSingle(),
    supabase
      .from("trainer_rating_summaries")
      .select("average_rating, weighted_rating, review_count")
      .eq("trainer_id", trainer.user_id)
      .maybeSingle(),
    supabase
      .from("programs")
      .select(
        "id, slug, title, summary, price_cents, currency, duration_value, duration_unit, delivery_mode, status",
      )
      .eq("trainer_id", trainer.user_id)
      .eq("status", "published")
      .eq("visibility", "public")
      .order("published_at", { ascending: false })
      .limit(20),
    supabase
      .from("reviews")
      .select("id, rating, comment, trainer_response, created_at, is_verified_purchase")
      .eq("trainer_id", trainer.user_id)
      .order("created_at", { ascending: false })
      .limit(10),
    // Safe columns only; RLS hides this table from non-owners, so this
    // returns rows only for the owner. Public viewers see area labels from
    // the search results instead.
    supabase
      .from("trainer_service_locations")
      .select("service_area_label")
      .eq("trainer_id", trainer.user_id),
  ]);

  const { data: { user } = { user: null } } = await supabase.auth.getUser();
  const { data: favorite } = user
    ? await supabase
        .from("favorites")
        .select("trainer_id")
        .eq("user_id", user.id)
        .eq("trainer_id", trainer.user_id)
        .maybeSingle()
    : { data: null };
  const favorited = Boolean(favorite);

  // Published public-profile media is world-readable via RLS.
  const { data: avatarMedia } = profile?.avatar_media_id
    ? await supabase
        .from("media_objects")
        .select("bucket, object_key")
        .eq("id", profile.avatar_media_id)
        .eq("status", "published")
        .eq("visibility", "public_profile")
        .maybeSingle()
    : { data: null };

  return (
    <article>
      <header>
        {avatarMedia && (
          <img
            src={publicMediaUrl(avatarMedia.bucket, avatarMedia.object_key)}
            alt={`${profile?.display_name ?? "Trainer"} profile photo`}
            width={112}
            height={112}
            style={{ borderRadius: "50%", objectFit: "cover" }}
          />
        )}
        <h1>{profile?.display_name ?? "Trainer"}</h1>
        <p>{trainer.headline}</p>
        <div className="meta" style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" }}>
          <span className="badge">
            {trainer.service_mode === "online"
              ? "Online coaching"
              : trainer.service_mode === "in_person"
                ? "In-person"
                : "Online & in-person"}
          </span>
          {trainer.years_experience ? (
            <span className="badge">{trainer.years_experience} yrs experience</span>
          ) : null}
          {(trainer.languages ?? []).map((lang: string) => (
            <span key={lang} className="badge">
              {lang}
            </span>
          ))}
          <span className="badge badge-verified">Identity verified</span>
          {rating && rating.review_count > 0 ? (
            <span>
              ★ {Number(rating.average_rating).toFixed(1)} · {rating.review_count} verified{" "}
              {rating.review_count === 1 ? "review" : "reviews"}
            </span>
          ) : (
            <span>No reviews yet</span>
          )}
        </div>
        {(locations ?? []).length > 0 && (
          <p style={{ color: "var(--color-text-muted)" }}>
            Serves: {(locations ?? []).map((l) => l.service_area_label).join(" · ")}
          </p>
        )}
        {user && user.id !== trainer.user_id && (
          <form action={toggleFavoriteAction}>
            <input type="hidden" name="slug" value={trainer.slug} />
            <input type="hidden" name="trainerId" value={trainer.user_id} />
            <input type="hidden" name="favorited" value={favorited ? "1" : "0"} />
            <button
              className="btn btn-secondary"
              type="submit"
              aria-pressed={favorited}
              aria-label={favorited ? "Remove trainer from saved" : "Save trainer"}
            >
              {favorited ? "★ Saved" : "☆ Save trainer"}
            </button>
          </form>
        )}
      </header>

      <section aria-labelledby="about-heading">
        <h2 id="about-heading">About</h2>
        {/* React escapes by default — user content is never rendered as HTML. */}
        <p style={{ whiteSpace: "pre-wrap" }}>{trainer.about}</p>
      </section>

      <section aria-labelledby="programs-heading">
        <h2 id="programs-heading">Programs</h2>
        {(programs ?? []).length === 0 ? (
          <div className="empty-state">No published programs right now.</div>
        ) : (
          <div className="results-grid">
            {(programs ?? []).map((program) => (
              <div key={program.id} className="card">
                <h3>{program.title}</h3>
                <p>{program.summary}</p>
                <p>
                  <strong>
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: program.currency.toUpperCase(),
                    }).format(program.price_cents / 100)}
                  </strong>{" "}
                  · {program.duration_value} {program.duration_unit}
                  {program.duration_value > 1 ? "s" : ""} of access
                </p>
                <BuyProgramButton programId={program.id} signedIn={Boolean(user)} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="reviews-heading">
        <h2 id="reviews-heading">Reviews</h2>
        {(reviews ?? []).length === 0 ? (
          <div className="empty-state">
            No reviews yet — be the first verified client to leave one.
          </div>
        ) : (
          (reviews ?? []).map((review) => (
            <div key={review.id} className="card" style={{ marginBottom: "var(--space-md)" }}>
              <p>
                <strong aria-label={`Rated ${review.rating} out of 5`}>
                  {"★".repeat(review.rating)}
                  {"☆".repeat(5 - review.rating)}
                </strong>{" "}
                {review.is_verified_purchase && (
                  <span className="badge badge-verified">Verified purchase</span>
                )}
              </p>
              {review.comment && <p>{review.comment}</p>}
              {review.trainer_response && (
                <p className="notice">
                  <strong>Trainer response:</strong> {review.trainer_response}
                </p>
              )}
            </div>
          ))
        )}
      </section>
    </article>
  );
}
