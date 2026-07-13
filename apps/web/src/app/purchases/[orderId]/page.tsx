import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { reviewCreateSchema } from "@fitmarket/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Purchase status" };
export const dynamic = "force-dynamic";

async function submitReviewAction(formData: FormData): Promise<void> {
  "use server";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in");

  const orderId = String(formData.get("orderId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  const comment = String(formData.get("comment") ?? "").trim();
  const parsed = reviewCreateSchema.safeParse({
    enrollmentId: String(formData.get("enrollmentId") ?? ""),
    rating: Number(formData.get("rating") ?? NaN),
    ...(comment ? { comment } : {}),
  });
  if (!parsed.success) redirect(`/purchases/${orderId}?review=invalid`);

  // RLS enforces eligibility: own active enrollment with the review
  // entitlement, one review per enrollment, trainer derived from enrollment.
  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("trainer_id")
    .eq("id", parsed.data.enrollmentId)
    .eq("client_id", user.id)
    .maybeSingle();
  if (!enrollment) redirect(`/purchases/${orderId}?review=invalid`);

  const { error } = await supabase.from("reviews").insert({
    enrollment_id: parsed.data.enrollmentId,
    reviewer_client_id: user.id,
    trainer_id: enrollment.trainer_id,
    rating: parsed.data.rating,
    comment: parsed.data.comment ?? null,
  });
  if (error) redirect(`/purchases/${orderId}?review=failed`);

  revalidatePath(`/purchases/${orderId}`);
  redirect(`/purchases/${orderId}?review=saved`);
}

/**
 * Post-checkout landing page. The redirect from Stripe proves NOTHING —
 * this page only reflects the order state that the verified webhook wrote.
 * While the webhook is in flight the order shows as processing.
 */
export default async function PurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orderId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  const query = await searchParams;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/purchases/${orderId}`);

  // RLS: only the buyer (or the trainer) can read this order.
  const { data: order } = await supabase
    .from("orders")
    .select("id, status, amount_cents, currency, created_at, program_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) notFound();

  const paid = order.status === "paid";
  const processing = ["created", "awaiting_payment"].includes(order.status);

  const { data: enrollment } = paid
    ? await supabase
        .from("enrollments")
        .select("id, status, access_ends_at, client_id")
        .eq("order_id", order.id)
        .maybeSingle()
    : { data: null };

  const canReview =
    enrollment !== null &&
    enrollment.client_id === user.id &&
    ["active", "paused"].includes(enrollment.status);
  const { data: existingReview } = enrollment
    ? await supabase
        .from("reviews")
        .select("rating, comment, created_at")
        .eq("enrollment_id", enrollment.id)
        .maybeSingle()
    : { data: null };

  return (
    <div className="card auth-card">
      <h1>Purchase status</h1>
      <p>
        Amount:{" "}
        <strong>
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: order.currency.toUpperCase(),
          }).format(order.amount_cents / 100)}
        </strong>
      </p>
      {paid && enrollment ? (
        <div className="notice" role="status">
          <p>
            <strong>Payment confirmed.</strong> Your program is active.
          </p>
          {enrollment.access_ends_at && (
            <p>
              Access ends on{" "}
              {new Date(enrollment.access_ends_at).toLocaleDateString("en-US", {
                dateStyle: "long",
              })}
              .
            </p>
          )}
        </div>
      ) : processing ? (
        <div className="notice" role="status">
          <p>
            <strong>Payment processing.</strong> We&apos;re waiting for confirmation from the
            payment provider. This page updates automatically — refresh in a few seconds.
          </p>
          <meta httpEquiv="refresh" content="5" />
        </div>
      ) : (
        <div className="notice notice-error" role="alert">
          <p>
            This order is {order.status.replaceAll("_", " ")}. If you believe this is wrong, contact
            support with order reference {order.id.slice(0, 8)}.
          </p>
        </div>
      )}

      {query.review === "saved" && (
        <p className="notice" role="status">
          Thanks — your review is published.
        </p>
      )}
      {(query.review === "invalid" || query.review === "failed") && (
        <p className="notice notice-error" role="alert">
          Your review could not be saved. Choose a rating from 1 to 5 and try again.
        </p>
      )}

      {existingReview ? (
        <div style={{ marginTop: "var(--space-lg)" }}>
          <h2>Your review</h2>
          <p>
            {"★".repeat(existingReview.rating)}
            {"☆".repeat(5 - existingReview.rating)}
            {existingReview.comment ? ` — ${existingReview.comment}` : ""}
          </p>
        </div>
      ) : canReview && enrollment ? (
        <form
          action={submitReviewAction}
          className="form-stack"
          style={{ marginTop: "var(--space-lg)" }}
        >
          <h2>Review your trainer</h2>
          <input type="hidden" name="enrollmentId" value={enrollment.id} />
          <input type="hidden" name="orderId" value={order.id} />
          <div className="field">
            <label htmlFor="rating">Rating</label>
            <select id="rating" name="rating" className="input" defaultValue="5" required>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} — {["", "poor", "fair", "good", "very good", "excellent"][n]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="comment">Comment (optional)</label>
            <textarea
              id="comment"
              name="comment"
              className="input"
              rows={4}
              maxLength={4000}
              placeholder="How was your experience with this trainer?"
            />
          </div>
          <button className="btn btn-primary" type="submit">
            Publish review
          </button>
        </form>
      ) : null}
    </div>
  );
}
