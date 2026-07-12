import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "@fitmarket/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "FitMarket — Find your trainer",
    template: "%s · FitMarket",
  },
  description: "Discover, compare and train with verified online and in-person personal trainers.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="visually-hidden">
          Skip to main content
        </a>
        <header className="site-header">
          <nav aria-label="Primary">
            <Link href="/" className="brand">
              FitMarket
            </Link>
            <div className="nav-links">
              <Link href="/search">Search</Link>
              <Link href="/search?mode=online">Online coaching</Link>
              <Link href="/auth/sign-in">Sign in</Link>
              <Link href="/auth/sign-up" className="btn btn-primary nav-cta">
                Get started
              </Link>
            </div>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <p>© {new Date().getFullYear()} FitMarket. Transparent pricing, verified reviews.</p>
        </footer>
      </body>
    </html>
  );
}
