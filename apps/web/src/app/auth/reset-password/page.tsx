import type { Metadata } from "next";
import { ResetPasswordForm } from "./reset-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <div className="card auth-card">
      <h1>Reset your password</h1>
      <ResetPasswordForm />
    </div>
  );
}
