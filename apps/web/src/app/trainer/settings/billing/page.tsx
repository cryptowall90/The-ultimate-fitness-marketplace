import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ApiRedirectButton } from "@/components/api-redirect-button";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  );

const SUBSCRIBED = new Set(["trialing", "active", "past_due", "grace_period"]);

/**
 * Trainer platform billing. Everything here is read-only state written by
 * the webhook/billing jobs (owner-select RLS); the only action is starting
 * the subscription checkout, which services/api prices from the policy table.
 */
export default async function TrainerBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/settings/billing");

  const params = await searchParams;
  const [{ data: trainer }, { data: account }, { data: policy }, { data: periods }] =
    await Promise.all([
      supabase
        .from("trainer_profiles")
        .select("application_status")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("trainer_subscription_accounts")
        .select("status, cancel_at_period_end, grace_period_ends_at, suspended_at")
        .eq("trainer_id", user.id)
        .maybeSingle(),
      supabase
        .from("trainer_billing_policy")
        .select("platform_subscription_cents, active_client_fee_cents, currency, trial_days")
        .lte("effective_at", new Date().toISOString())
        .order("effective_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("trainer_subscription_periods")
        .select(
          "id, period_start, period_end, base_amount_cents, active_client_count, active_client_fee_cents, currency, status",
        )
        .eq("trainer_id", user.id)
        .order("period_start", { ascending: false })
        .limit(6),
    ]);

  if (!trainer) {
    return (
      <div>
        <h1>Billing</h1>
        <div className="card">
          <p>
            Billing is available once you have a trainer profile.{" "}
            <Link href="/trainer/apply">Apply to become a trainer</Link>.
          </p>
        </div>
      </div>
    );
  }

  const subscribed = SUBSCRIBED.has(account?.status ?? "");
  const currency = policy?.currency ?? "usd";

  // Own charges for the most recent period, if any.
  const latestPeriod = (periods ?? [])[0];
  const { data: charges } = latestPeriod
    ? await supabase
        .from("active_client_billing_ledger")
        .select("id, amount_cents, currency, status, created_at")
        .eq("trainer_id", user.id)
        .eq("trainer_billing_period_start", latestPeriod.period_start)
        .order("created_at")
        .limit(100)
    : { data: [] };

  return (
    <div>
      <h1>Billing</h1>

      {params.status === "success" && (
        <p className="notice" role="status">
          Subscription started — your account updates as soon as the payment provider confirms it.
        </p>
      )}
      {params.status === "canceled" && (
        <p className="notice notice-error" role="alert">
          Checkout was canceled. Your subscription has not changed.
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Platform subscription</h2>
        {policy && (
          <p>
            {money(policy.platform_subscription_cents, currency)}/month plus{" "}
            {money(policy.active_client_fee_cents, currency)} per active client per month
            {policy.trial_days > 0 ? ` — ${policy.trial_days}-day free trial` : ""}.
          </p>
        )}
        {subscribed ? (
          <>
            <p>
              Status: <strong>{(account?.status ?? "").replaceAll("_", " ")}</strong>
              {account?.cancel_at_period_end ? " (cancels at period end)" : ""}
            </p>
            {account?.status === "past_due" || account?.status === "grace_period" ? (
              <p className="notice notice-error" role="alert">
                Payment is overdue
                {account.grace_period_ends_at
                  ? ` — your profile will be unpublished after ${new Date(
                      account.grace_period_ends_at,
                    ).toLocaleDateString()}`
                  : ""}
                . Update your payment method via the checkout below.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p>
              {account?.suspended_at
                ? "Your subscription is suspended — restart it to publish your profile again."
                : "Start your subscription to publish your profile and sell programs."}
            </p>
            <ApiRedirectButton
              path="/v1/trainer/subscription/checkout"
              label="Start subscription"
              busyLabel="Preparing secure checkout…"
            />
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Billing periods</h2>
        {(periods ?? []).length === 0 ? (
          <p>No billing periods yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Base</th>
                <th scope="col">Active clients</th>
                <th scope="col">Client fees</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {(periods ?? []).map((p) => (
                <tr key={p.id}>
                  <td>
                    {new Date(p.period_start).toLocaleDateString()} –{" "}
                    {new Date(p.period_end).toLocaleDateString()}
                  </td>
                  <td>{money(p.base_amount_cents, p.currency)}</td>
                  <td>{p.active_client_count ?? "—"}</td>
                  <td>
                    {p.active_client_fee_cents !== null
                      ? money(p.active_client_fee_cents, p.currency)
                      : "—"}
                  </td>
                  <td>{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {latestPeriod && (charges ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
          <h2>Active-client charges (current period)</h2>
          <ul>
            {(charges ?? []).map((c) => (
              <li key={c.id}>
                {money(c.amount_cents, c.currency)} · {c.status} ·{" "}
                {new Date(c.created_at).toLocaleDateString()}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p>
        <Link href="/trainer/settings/payouts">Payout settings →</Link>
      </p>
    </div>
  );
}
