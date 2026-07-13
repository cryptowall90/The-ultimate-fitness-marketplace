import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import { newCorrelationId, withCorrelation } from "@fitmarket/observability";
import type {
  PaymentGateway,
  SubscriptionGateway,
  WebhookVerifier,
  ConnectGateway,
} from "@fitmarket/payments";
import { adminTrainerDecisionSchema, createCheckoutSchema } from "@fitmarket/validation";
import type { ApiEnv } from "./env.js";
import { bearerAuth, jobAuth, requireAppRole } from "./auth.js";
import { TokenBucketLimiter, rateLimit } from "./ratelimit.js";
import { CheckoutError, createProgramCheckout } from "./services/checkout.js";
import {
  TrainerApplicationError,
  approveTrainerApplication,
  listSubmittedApplications,
  rejectTrainerApplication,
} from "./services/trainerApplications.js";
import { processStripeEvent } from "./services/webhooks.js";
import { runActiveClientBilling } from "./services/activeClientBilling.js";

export interface AppDeps {
  env: ApiEnv;
  pool: pg.Pool;
  log: Logger;
  paymentGateway: PaymentGateway;
  subscriptionGateway: SubscriptionGateway;
  connectGateway: ConnectGateway;
  webhookVerifier: WebhookVerifier;
}

export function buildApp(deps: AppDeps): Hono {
  const { env, pool, log } = deps;
  const app = new Hono();

  const ipLimiter = new TokenBucketLimiter(60, 1); // 60 burst, 1/s refill
  const checkoutLimiter = new TokenBucketLimiter(10, 0.1); // 10 burst, 6/min

  // Correlation ID + request logging (redacting logger; no bodies logged).
  app.use("*", async (c, next) => {
    const correlationId = c.req.header("x-correlation-id") ?? newCorrelationId();
    c.set("correlationId", correlationId);
    c.header("x-correlation-id", correlationId);
    const reqLog = withCorrelation(log, correlationId);
    const start = Date.now();
    await next();
    reqLog.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      "request",
    );
  });

  // Security headers (API responses are JSON; CSP locks down anything rendered).
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    c.header("Cache-Control", "no-store");
  });

  app.use(
    "*",
    cors({
      origin: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-Correlation-Id"],
      maxAge: 600,
      credentials: false, // bearer tokens, not cookies — CSRF surface removed
    }),
  );

  app.use("*", rateLimit(ipLimiter, "ip"));
  app.use("*", bodyLimit({ maxSize: 256 * 1024 })); // webhook payloads stay small

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await pool.query("select 1");
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // ---------------------------------------------------------------------
  // Stripe webhooks: signature-verified, deduped, idempotent.
  // ---------------------------------------------------------------------
  app.post("/v1/webhooks/stripe", async (c) => {
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: { code: "invalid_signature", message: "Missing signature" } }, 400);
    }
    const rawBody = await c.req.text();
    let event;
    try {
      event = deps.webhookVerifier.verify(rawBody, signature);
    } catch {
      withCorrelation(log, c.get("correlationId")).warn("webhook signature verification failed");
      return c.json({ error: { code: "invalid_signature", message: "Invalid signature" } }, 400);
    }
    try {
      const result = await processStripeEvent(
        pool,
        withCorrelation(log, c.get("correlationId")),
        event,
      );
      return c.json({ received: true, outcome: result.outcome });
    } catch (err) {
      withCorrelation(log, c.get("correlationId")).error(
        { err: (err as Error).message, eventType: event.type },
        "webhook processing failed",
      );
      // 500 → Stripe retries; row already marked failed for dead-letter handling.
      return c.json({ error: { code: "processing_failed", message: "Processing failed" } }, 500);
    }
  });

  // ---------------------------------------------------------------------
  // Client checkout (authenticated). Amounts come from the database.
  // ---------------------------------------------------------------------
  app.post(
    "/v1/checkout/programs",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    rateLimit(checkoutLimiter, "user"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = createCheckoutSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request", message: "Invalid request body" } }, 400);
      }
      try {
        const result = await createProgramCheckout(pool, deps.paymentGateway, {
          programId: parsed.data.programId,
          clientUserId: c.get("user").userId,
          appBaseUrl: env.APP_BASE_URL,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof CheckoutError) {
          const status = err.code === "program_not_found" ? 404 : 409;
          return c.json({ error: { code: err.code, message: err.message } }, status);
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------
  // Trainer Connect onboarding link (authenticated trainer).
  // ---------------------------------------------------------------------
  app.post(
    "/v1/trainer/connect/onboarding-link",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    rateLimit(checkoutLimiter, "user"),
    async (c) => {
      const userId = c.get("user").userId;
      const trainer = await pool.query(
        `select tp.user_id, u.id, au.email, sca.stripe_account_id
         from trainer_profiles tp
         join users u on u.id = tp.user_id
         join auth.users au on au.id = u.id
         left join stripe_connected_accounts sca on sca.trainer_id = tp.user_id
         where tp.user_id = $1`,
        [userId],
      );
      const row = trainer.rows[0];
      if (!row) {
        return c.json(
          { error: { code: "not_a_trainer", message: "Trainer profile required" } },
          403,
        );
      }
      let accountId: string = row.stripe_account_id;
      if (!accountId) {
        const created = await deps.connectGateway.createConnectedAccount({
          trainerUserId: userId,
          email: row.email,
          country: "US",
          idempotencyKey: `connect-account:${userId}`,
        });
        accountId = created.providerAccountId;
        await pool.query(
          `insert into stripe_connected_accounts (trainer_id, stripe_account_id)
           values ($1,$2) on conflict (trainer_id) do nothing`,
          [userId, accountId],
        );
      }
      const link = await deps.connectGateway.createOnboardingLink({
        providerAccountId: accountId,
        refreshUrl: `${env.APP_BASE_URL}/trainer/settings/payouts?refresh=1`,
        returnUrl: `${env.APP_BASE_URL}/trainer/settings/payouts?complete=1`,
      });
      return c.json({ url: link.url, expiresAt: link.expiresAt.toISOString() });
    },
  );

  // ---------------------------------------------------------------------
  // Trainer platform-subscription checkout ($34.99/mo via Stripe Billing).
  // ---------------------------------------------------------------------
  app.post(
    "/v1/trainer/subscription/checkout",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    rateLimit(checkoutLimiter, "user"),
    async (c) => {
      const userId = c.get("user").userId;
      const trainer = await pool.query(
        `select tp.user_id, au.email, tsa.stripe_customer_id,
                (select trial_days from trainer_billing_policy
                 where effective_at <= now() order by effective_at desc limit 1) as trial_days
         from trainer_profiles tp
         join auth.users au on au.id = tp.user_id
         left join trainer_subscription_accounts tsa on tsa.trainer_id = tp.user_id
         where tp.user_id = $1`,
        [userId],
      );
      const row = trainer.rows[0];
      if (!row) {
        return c.json(
          { error: { code: "not_a_trainer", message: "Trainer profile required" } },
          403,
        );
      }
      let customerId: string = row.stripe_customer_id;
      if (!customerId) {
        const created = await deps.subscriptionGateway.createCustomer({
          trainerUserId: userId,
          email: row.email,
          idempotencyKey: `sub-customer:${userId}`,
        });
        customerId = created.providerCustomerId;
        await pool.query(
          `insert into trainer_subscription_accounts (trainer_id, stripe_customer_id)
           values ($1,$2) on conflict (trainer_id) do nothing`,
          [userId, customerId],
        );
      }
      const session = await deps.subscriptionGateway.createSubscriptionCheckout({
        providerCustomerId: customerId,
        priceLookupKey: "trainer_platform_monthly",
        trialDays: row.trial_days ?? 0,
        successUrl: `${env.APP_BASE_URL}/trainer/settings/billing?status=success`,
        cancelUrl: `${env.APP_BASE_URL}/trainer/settings/billing?status=canceled`,
        idempotencyKey: `sub-checkout:${userId}:${new Date().toISOString().slice(0, 10)}`,
      });
      return c.json({ url: session.url });
    },
  );

  // ---------------------------------------------------------------------
  // Admin: trainer application review. Approval columns are guarded at the
  // database level (service context only), so decisions must flow through
  // here — with an admin role check and an immutable audit record.
  // ---------------------------------------------------------------------
  const adminGuard = [bearerAuth(env.SUPABASE_JWT_SECRET), requireAppRole(pool, "admin")] as const;

  app.get("/v1/admin/trainer-applications", ...adminGuard, async (c) => {
    const applications = await listSubmittedApplications(pool);
    return c.json({ applications });
  });

  const decide = (action: "approve" | "reject") => async (c: HonoContext) => {
    const body = await c.req.json().catch(() => null);
    const parsed = adminTrainerDecisionSchema.safeParse({
      ...(body ?? {}),
      trainerId: c.req.param("trainerId"),
    });
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_request", message: "Invalid request body" } }, 400);
    }
    const input = {
      trainerId: parsed.data.trainerId,
      adminId: c.get("user").userId,
      reason: parsed.data.reason,
    };
    try {
      const result =
        action === "approve"
          ? await approveTrainerApplication(pool, input)
          : await rejectTrainerApplication(pool, input);
      return c.json(result);
    } catch (err) {
      if (err instanceof TrainerApplicationError) {
        const status = err.code === "application_not_found" ? 404 : 409;
        return c.json({ error: { code: err.code, message: err.message } }, status);
      }
      throw err;
    }
  };

  app.post("/v1/admin/trainer-applications/:trainerId/approve", ...adminGuard, decide("approve"));
  app.post("/v1/admin/trainer-applications/:trainerId/reject", ...adminGuard, decide("reject"));

  // ---------------------------------------------------------------------
  // Scheduled jobs (invoked by cron with the job token).
  // ---------------------------------------------------------------------
  app.post("/v1/jobs/active-client-billing", jobAuth(env.JOB_TOKEN), async (c) => {
    const result = await runActiveClientBilling(
      pool,
      deps.subscriptionGateway,
      withCorrelation(log, c.get("correlationId")),
    );
    return c.json(result);
  });

  // Expire enrollments/entitlements whose window has passed; make
  // conversations read-only. Idempotent.
  app.post("/v1/jobs/expire-entitlements", jobAuth(env.JOB_TOKEN), async (c) => {
    const expired = await pool.query(
      `update entitlements set status = 'expired'
       where status = 'active' and ends_at is not null and ends_at <= now()
       returning enrollment_id`,
    );
    await pool.query(
      `update enrollments set status = 'expired'
       where status in ('active','paused') and access_ends_at is not null and access_ends_at <= now()`,
    );
    await pool.query(
      `update conversations c set status = 'read_only'
       from enrollments en
       where c.enrollment_id = en.id and c.status = 'active' and en.status = 'expired'`,
    );
    return c.json({ expiredEntitlements: expired.rowCount ?? 0 });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.onError((err, c) => {
    withCorrelation(log, c.get("correlationId") ?? "unknown").error(
      { err: err.message },
      "unhandled error",
    );
    // Safe error responses: no stack traces or internals to the client.
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Internal error",
          correlationId: c.get("correlationId"),
        },
      },
      500,
    );
  });

  return app;
}
