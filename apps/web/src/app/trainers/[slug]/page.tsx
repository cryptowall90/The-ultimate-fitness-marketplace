import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BuyProgramButton } from "./buy-button";

export const dynamic = "force-dynamic";

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

  const [{ data: profile }, { data: rating }, { data: programs }, { data: reviews }, { data: locations }] =
    await Promise.all([
      supabase.from("profiles").select("display_name, bio").eq("user_id", trainer.user_id).maybeSingle(),
      supabase
        .from("trainer_rating_summaries")
        .select("average_rating, weighted_rating, review_count")
        .eq("trainer_id", trainer.user_id)
        .maybeSingle(),
      supabase
        .from("programs")
        .select("id, slug, title, summary, price_cents, currency, duration_value, duration_unit, delivery_mode, status")
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

  return (
    <article>
      <header>
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
          <div className="empty-state">No reviews yet — be the first verified client to leave one.</div>
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
