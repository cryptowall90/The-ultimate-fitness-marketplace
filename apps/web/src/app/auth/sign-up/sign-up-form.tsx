"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const formSchema = z
  .object({
    displayName: z.string().trim().min(1, "Please enter a display name").max(80),
    email: z.string().trim().email("Enter a valid email address").max(254),
    password: z.string().min(10, "Use at least 10 characters").max(128),
    acceptTerms: z.literal(true, {
      errorMap: () => ({ message: "You must accept the terms to continue" }),
    }),
    // Honeypot — real users never see or fill this.
    website: z.string().max(0).optional(),
  })
  .strict();

type FormValues = z.infer<typeof formSchema>;

export function SignUpForm() {
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  async function onSubmit(values: FormValues) {
    setServerMessage(null);
    if (values.website) return; // honeypot tripped: silently drop
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        data: { display_name: values.displayName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      // Enumeration-resistant: uniform message regardless of cause.
      setServerMessage("We couldn't create the account. Check the details and try again.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <p className="notice" role="status">
        Check your inbox — we sent a verification link. You need to verify your email before signing
        in.
      </p>
    );
  }

  return (
    <form className="form-stack" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="field">
        <label htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          className="input"
          autoComplete="name"
          aria-invalid={Boolean(errors.displayName)}
          {...register("displayName")}
        />
        {errors.displayName && <p className="field-error">{errors.displayName.message}</p>}
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          className="input"
          autoComplete="email"
          aria-invalid={Boolean(errors.email)}
          {...register("email")}
        />
        {errors.email && <p className="field-error">{errors.email.message}</p>}
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          className="input"
          autoComplete="new-password"
          aria-invalid={Boolean(errors.password)}
          {...register("password")}
        />
        {errors.password && <p className="field-error">{errors.password.message}</p>}
      </div>
      <div style={{ position: "absolute", left: "-9999px" }} aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" tabIndex={-1} autoComplete="off" {...register("website")} />
      </div>
      <div className="field">
        <label style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
          <input type="checkbox" {...register("acceptTerms")} style={{ marginTop: 4 }} />
          <span>
            I agree to the <a href="/legal/terms">Terms of Service</a> and{" "}
            <a href="/legal/privacy">Privacy Policy</a>.
          </span>
        </label>
        {errors.acceptTerms && <p className="field-error">{errors.acceptTerms.message}</p>}
      </div>
      {serverMessage && (
        <p className="field-error" role="alert">
          {serverMessage}
        </p>
      )}
      <button
        className="btn btn-primary"
        type="submit"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
