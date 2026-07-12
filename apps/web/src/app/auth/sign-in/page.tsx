import type { Metadata } from "next";
import { Suspense } from "react";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="card auth-card">
      <h1>Sign in</h1>
      <Suspense>
        <SignInForm />
      </Suspense>
    </div>
  );
}
