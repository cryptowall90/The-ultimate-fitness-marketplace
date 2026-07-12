"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function ResetPasswordForm() {
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/account/change-password`,
    });
    // Always show success (enumeration-resistant).
    setSubmitting(false);
    setDone(true);
  }

  if (done) {
    return (
      <p className="notice" role="status">
        If an account exists for that address, a reset link is on its way.
      </p>
    );
  }

  return (
    <form className="form-stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <button className="btn btn-primary" type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
