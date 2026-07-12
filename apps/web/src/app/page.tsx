import Link from "next/link";

export default function HomePage() {
  return (
    <div className="hero">
      <h1>Train with someone who gets you</h1>
      <p>
        Compare verified online and in-person personal trainers, read reviews from real
        clients, and buy programs with transparent pricing and clear end dates.
      </p>
      <div style={{ display: "flex", gap: "var(--space-md)", justifyContent: "center", flexWrap: "wrap" }}>
        <Link href="/search" className="btn btn-primary">
          Find a trainer near you
        </Link>
        <Link href="/search?mode=online" className="btn btn-secondary">
          Browse online coaching
        </Link>
      </div>
      <section aria-label="How it works" style={{ marginTop: "var(--space-xl)" }}>
        <div className="results-grid">
          <div className="card">
            <h3>Verified reviews</h3>
            <p>Only clients with a real purchase can review — no fake ratings.</p>
          </div>
          <div className="card">
            <h3>Secure payments</h3>
            <p>Checkout runs through Stripe. Trainers are paid via Stripe Connect.</p>
          </div>
          <div className="card">
            <h3>Clear terms</h3>
            <p>Program duration, access end date and cancellation terms up front.</p>
          </div>
          <div className="card">
            <h3>Private by default</h3>
            <p>Your progress photos and check-ins stay between you and your trainer.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
