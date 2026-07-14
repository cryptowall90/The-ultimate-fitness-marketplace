import { serve } from "@hono/node-server";
import { createLogger } from "@fitmarket/observability";
import {
  StripeBalanceGateway,
  StripeConnectGateway,
  StripePaymentGateway,
  StripeSubscriptionGateway,
  StripeWebhookVerifier,
  createStripeClient,
} from "@fitmarket/payments";
import { SupabaseStorageProvider, type MediaStorageProvider } from "@fitmarket/media";
import { loadEnv } from "./env.js";
import { createPool } from "./db.js";
import { buildApp } from "./app.js";
import { ChainGeocoder, NominatimGeocoder, StaticCityGeocoder } from "./services/geocoding.js";

const env = loadEnv(); // throws (fails closed) when secrets are missing
const log = createLogger({ service: "fitmarket-api" });
const pool = createPool(env.DATABASE_URL);
const stripe = createStripeClient(env.STRIPE_SECRET_KEY);

// Media storage: fail closed when unconfigured — upload routes 500 without
// ever issuing a signed URL, instead of silently degrading.
const mediaStorage: MediaStorageProvider =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseStorageProvider(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : {
        name: "supabase_storage",
        createSignedUpload: () => Promise.reject(new Error("media storage not configured")),
        createSignedDownload: () => Promise.reject(new Error("media storage not configured")),
        getObject: () => Promise.reject(new Error("media storage not configured")),
        deleteObject: () => Promise.reject(new Error("media storage not configured")),
      };
if (env.NODE_ENV === "production" && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) {
  log.warn("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — media uploads are disabled");
}

const app = buildApp({
  env,
  pool,
  log,
  paymentGateway: new StripePaymentGateway(stripe),
  subscriptionGateway: new StripeSubscriptionGateway(stripe),
  connectGateway: new StripeConnectGateway(stripe),
  webhookVerifier: new StripeWebhookVerifier(stripe, env.STRIPE_WEBHOOK_SECRET),
  mediaStorage,
  balanceGateway: new StripeBalanceGateway(stripe),
  // Launch cities resolve locally; the external adapter only exists when a
  // base URL is configured (allowlisted egress per docs/GEOGRAPHIC_SEARCH.md).
  geocoder: new ChainGeocoder([
    new StaticCityGeocoder(),
    ...(env.GEOCODER_URL ? [new NominatimGeocoder(env.GEOCODER_URL, log)] : []),
  ]),
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
