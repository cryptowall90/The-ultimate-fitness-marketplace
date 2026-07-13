import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ApiRedirectButton } from "@/components/api-redirect-button";

export const metadata: Metadata = { title: "Payouts" };
export const dynamic = "force-dynamic";

/**
 * Stripe Connect onboarding status. The connected-account row is written
 * only by webhooks/services/api; this page reads it via owner-select RLS and
 * requests fresh onboarding links from the privileged server.
 */
export default async function TrainerPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/sign-in?next=/trainer/settings/payouts");

  const params = await searchParams;
  const [{ data: trainer }, { data: account }] = await Promise.all([
    supabase
      .from("trainer_profiles")
      .select("application_status")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("stripe_connected_accounts")
      .select("details_submitted, charges_enabled, payouts_enabled, disabled_reason")
      .eq("trainer_id", user.id)
      .maybeSingle(),
  ]);

  if (!trainer) {
    return (
      <div>
        <h1>Payouts</h1>
        <div className="card">
          <p>
            Payouts are available once you have a trainer profile.{" "}
            <Link href="/trainer/apply">Apply to become a trainer</Link>.
          </p>
        </div>
      </div>
    );
  }

  const ready = Boolean(account?.charges_enabled && account?.payouts_enabled);

  return (
    <div>
      <h1>Payouts</h1>

      {params.complete === "1" && (
        <p className="notice" role="status">
          Onboarding submitted — your status updates as soon as the payment provider confirms it.
        </p>
      )}
      {params.refresh === "1" && (
        <p className="notice" role="status">
          The onboarding link expired — request a new one below.
        </p>
      )}

      <div className="card" style={{ marginBottom: "var(--space-lg)" }}>
        <h2>Payout account</h2>
        {ready ? (
          <p>
            <strong>Your payout account is active.</strong> Client payments are routed directly to
            your connected account.
          </p>
        ) : (
          <>
            <p>
              {account?.details_submitted
                ? "Your details are submitted and under review by the payment provider."
                : "Connect a payout account to receive client payments. You'll be redirected to our payment provider — we never see your banking details."}
            </p>
            {account?.disabled_reason && (
              <p className="notice notice-error" role="alert">
                Action needed: {account.disabled_reason.replaceAll("_", " ")}
              </p>
            )}
            <ApiRedirectButton
              path="/v1/trainer/connect/onboarding-link"
              label={account ? "Continue onboarding" : "Set up payouts"}
              busyLabel="Preparing secure onboarding…"
            />
          </>
        )}
        <ul>
          <li>Details submitted: {account?.details_submitted ? "yes" : "no"}</li>
          <li>Charges enabled: {account?.charges_enabled ? "yes" : "no"}</li>
          <li>Payouts enabled: {account?.payouts_enabled ? "yes" : "no"}</li>
        </ul>
      </div>

      <p>
        <Link href="/trainer/settings/billing">← Billing</Link>
      </p>
    </div>
  );
}
