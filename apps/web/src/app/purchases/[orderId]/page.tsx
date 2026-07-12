import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Purchase status" };
export const dynamic = "force-dynamic";

/**
 * Post-checkout landing page. The redirect from Stripe proves NOTHING —
 * this page only reflects the order state that the verified webhook wrote.
 * While the webhook is in flight the order shows as processing.
 */
export default async function PurchasePage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();

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
        .select("id, status, access_ends_at")
        .eq("order_id", order.id)
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
    </div>
  );
}
