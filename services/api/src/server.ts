import { serve } from "@hono/node-server";
import { createLogger } from "@fitmarket/observability";
import {
  StripeConnectGateway,
  StripePaymentGateway,
  StripeReconciliationGateway,
  StripeSubscriptionGateway,
  StripeWebhookVerifier,
  createStripeClient,
} from "@fitmarket/payments";
import { SupabaseStorageProvider } from "@fitmarket/media";
import { loadEnv } from "./env.js";
import { createPool } from "./db.js";
import { buildApp } from "./app.js";

const env = loadEnv(); // throws (fails closed) when secrets are missing
const log = createLogger({ service: "fitmarket-api" });
const pool = createPool(env.DATABASE_URL);
const stripe = createStripeClient(env.STRIPE_SECRET_KEY);

const app = buildApp({
  env,
  pool,
  log,
  paymentGateway: new StripePaymentGateway(stripe),
  subscriptionGateway: new StripeSubscriptionGateway(stripe),
  connectGateway: new StripeConnectGateway(stripe),
  webhookVerifier: new StripeWebhookVerifier(stripe, env.STRIPE_WEBHOOK_SECRET),
  mediaProvider: new SupabaseStorageProvider(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  reconciliationGateway: new StripeReconciliationGateway(stripe),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, "api listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    // force-exit fallback
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
