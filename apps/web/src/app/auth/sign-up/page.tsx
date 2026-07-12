import type { Metadata } from "next";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <div className="card auth-card">
      <h1>Create your free account</h1>
      <p>Clients never pay platform fees. You&apos;ll verify your email before signing in.</p>
      <SignUpForm />
    </div>
  );
}
