import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import type { Logger } from "@fitmarket/observability";
import { newCorrelationId, withCorrelation } from "@fitmarket/observability";
import type {
  PaymentGateway,
  ReconciliationGateway,
  SubscriptionGateway,
  WebhookVerifier,
  ConnectGateway,
} from "@fitmarket/payments";
import type { MediaStorageProvider } from "@fitmarket/media";
import {
  createCheckoutSchema,
  createSignedUploadSchema,
  trainerApplicationDecisionSchema,
  trainerApplicationListSchema,
  uuid,
} from "@fitmarket/validation";
import type { ApiEnv } from "./env.js";
import { bearerAuth, jobAuth } from "./auth.js";
import { TokenBucketLimiter, rateLimit } from "./ratelimit.js";
import { CheckoutError, createProgramCheckout } from "./services/checkout.js";
import { processStripeEvent } from "./services/webhooks.js";
import { runActiveClientBilling } from "./services/activeClientBilling.js";
import {
  AdminTrainerError,
  decideTrainerApplication,
  listTrainerApplications,
} from "./services/adminTrainers.js";
import { MediaUploadError, createSignedUpload, finalizeUpload } from "./services/mediaUploads.js";
import { runReconciliation } from "./services/reconciliation.js";

export interface AppDeps {
  env: ApiEnv;
  pool: pg.Pool;
  log: Logger;
  paymentGateway: PaymentGateway;
  subscriptionGateway: SubscriptionGateway;
  connectGateway: ConnectGateway;
  webhookVerifier: WebhookVerifier;
  mediaProvider: MediaStorageProvider;
  reconciliationGateway: ReconciliationGateway;
}

export function buildApp(deps: AppDeps): Hono {
  const { env, pool, log } = deps;
  const app = new Hono();

  const ipLimiter = new TokenBucketLimiter(60, 1); // 60 burst, 1/s refill
  const checkoutLimiter = new TokenBucketLimiter(10, 0.1); // 10 burst, 6/min
  const uploadLimiter = new TokenBucketLimiter(20, 0.2); // 20 burst, 12/min

  /** Requires an 'admin' row in user_roles; run AFTER bearerAuth. */
  const requireAdmin: MiddlewareHandler = async (c, next) => {
    const res = await pool.query(`select 1 from user_roles where user_id = $1 and role = 'admin'`, [
      c.get("user").userId,
    ]);
    if (res.rowCount === 0) {
      return c.json({ error: { code: "forbidden", message: "Admin role required" } }, 403);
    }
    await next();
  };

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
  // Media signed uploads (authenticated). Real content is verified with
  // magic bytes at finalize; publication remains a server-managed step.
  // ---------------------------------------------------------------------
  const mediaErrorStatus: Record<MediaUploadError["code"], 400 | 404 | 409 | 429> = {
    unsupported_type: 400,
    too_large: 400,
    quota_exceeded: 409,
    too_many_pending: 429,
    not_found: 404,
    not_uploaded: 409,
  };

  app.post(
    "/v1/media/uploads",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    rateLimit(uploadLimiter, "user"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = createSignedUploadSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request", message: "Invalid request body" } }, 400);
      }
      try {
        const result = await createSignedUpload(pool, deps.mediaProvider, {
          userId: c.get("user").userId,
          ...parsed.data,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof MediaUploadError) {
          return c.json(
            { error: { code: err.code, message: err.message } },
            mediaErrorStatus[err.code],
          );
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/media/uploads/:id/complete",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    rateLimit(uploadLimiter, "user"),
    async (c) => {
      const mediaId = uuid.safeParse(c.req.param("id"));
      if (!mediaId.success) {
        return c.json({ error: { code: "invalid_request", message: "Invalid media id" } }, 400);
      }
      try {
        const result = await finalizeUpload(pool, deps.mediaProvider, {
          userId: c.get("user").userId,
          mediaId: mediaId.data,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof MediaUploadError) {
          return c.json(
            { error: { code: err.code, message: err.message } },
            mediaErrorStatus[err.code],
          );
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------
  // Admin: trainer application review. bearerAuth + admin role; decisions
  // are audited in admin_actions inside the same transaction.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/admin/trainer-applications",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    requireAdmin,
    async (c) => {
      const parsed = trainerApplicationListSchema.safeParse({
        status: c.req.query("status") ?? undefined,
      });
      if (!parsed.success) {
        return c.json(
          { error: { code: "invalid_request", message: "Invalid status filter" } },
          400,
        );
      }
      const applications = await listTrainerApplications(pool, parsed.data.status);
      return c.json({ applications });
    },
  );

  app.post(
    "/v1/admin/trainer-applications/decision",
    bearerAuth(env.SUPABASE_JWT_SECRET),
    requireAdmin,
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = trainerApplicationDecisionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request", message: "Invalid request body" } }, 400);
      }
      try {
        const result = await decideTrainerApplication(pool, {
          ...parsed.data,
          actorId: c.get("user").userId,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof AdminTrainerError) {
          const status = err.code === "application_not_found" ? 404 : 409;
          return c.json({ error: { code: err.code, message: err.message } }, status);
        }
        throw err;
      }
    },
  );

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

  // Daily reconciliation: dead-letter webhook replay + internal-vs-provider
  // money comparison. Mismatches are logged at error level and stored on the
  // scheduled_job_runs row.
  app.post("/v1/jobs/reconciliation", jobAuth(env.JOB_TOKEN), async (c) => {
    const result = await runReconciliation(
      pool,
      deps.reconciliationGateway,
      withCorrelation(log, c.get("correlationId")),
    );
    return c.json(result);
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
