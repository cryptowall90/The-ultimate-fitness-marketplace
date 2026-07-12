import { SignJWT } from "jose";
import pg from "pg";
import type { Hono } from "hono";
import type Stripe from "stripe";
import { createLogger } from "@fitmarket/observability";
import { StripeWebhookVerifier, createStripeClient } from "@fitmarket/payments";
import { Writable } from "node:stream";
import { buildApp, type AppDeps } from "../src/app.js";
import type { ApiEnv } from "../src/env.js";
import { FakeConnectGateway, FakePaymentGateway, FakeSubscriptionGateway } from "./fakes.js";
import { API_TEST_DATABASE_URL } from "./global-setup.js";

export const TEST_JWT_SECRET = "test-jwt-secret-which-is-long-enough-000";
export const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_api_tests";
export const TEST_JOB_TOKEN = "job-token-test-0123456789abcdef0123456789";

export const testEnv: ApiEnv = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: API_TEST_DATABASE_URL,
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  STRIPE_SECRET_KEY: "sk_test_dummy_key_never_used_for_network",
  STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  JOB_TOKEN: TEST_JOB_TOKEN,
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_BASE_URL: "http://localhost:3000",
};

export interface TestApp {
  app: Hono;
  pool: pg.Pool;
  stripe: Stripe;
  payments: FakePaymentGateway;
  subscriptions: FakeSubscriptionGateway;
  connect: FakeConnectGateway;
  close: () => Promise<void>;
}

export function createTestApp(): TestApp {
  const pool = new pg.Pool({ connectionString: API_TEST_DATABASE_URL, max: 4 });
  const stripe = createStripeClient(testEnv.STRIPE_SECRET_KEY);
  const payments = new FakePaymentGateway();
  const subscriptions = new FakeSubscriptionGateway();
  const connect = new FakeConnectGateway();
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const deps: AppDeps = {
    env: testEnv,
    pool,
    log: createLogger({ service: "api-test", destination: sink }),
    paymentGateway: payments,
    subscriptionGateway: subscriptions,
    connectGateway: connect,
    webhookVerifier: new StripeWebhookVerifier(stripe, TEST_WEBHOOK_SECRET),
  };
  return {
    app: buildApp(deps),
    pool,
    stripe,
    payments,
    subscriptions,
    connect,
    close: () => pool.end(),
  };
}

export async function signAccessToken(userId: string, secret = TEST_JWT_SECRET): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

export function signStripeEvent(
  stripe: Stripe,
  event: object,
  secret = TEST_WEBHOOK_SECRET,
): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return { body, signature };
}

let fixtureCounter = 0;

export async function createUser(pool: pg.Pool, prefix: string): Promise<string> {
  fixtureCounter += 1;
  const res = await pool.query(
    `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
    [`${prefix}-${Date.now()}-${fixtureCounter}@test.invalid`],
  );
  return res.rows[0].id as string;
}

export interface TrainerFixture {
  trainerId: string;
  programId: string;
}

/** Approved public trainer with connect account, active subscription and a published program. */
export async function createSellableTrainer(pool: pg.Pool): Promise<TrainerFixture> {
  const trainerId = await createUser(pool, "api-trainer");
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'trainer')`, [trainerId]);
  await pool.query(
    `insert into trainer_profiles (user_id, slug, headline, about, application_status, is_public, approved_at)
     values ($1, $2, 'Coach', 'About', 'approved', true, now())`,
    [trainerId, `api-coach-${fixtureCounter}-${Date.now()}`],
  );
  await pool.query(
    `insert into stripe_connected_accounts (trainer_id, stripe_account_id, details_submitted, charges_enabled, payouts_enabled)
     values ($1, $2, true, true, true)`,
    [trainerId, `acct_fixture${fixtureCounter}${Date.now()}`],
  );
  await pool.query(
    `insert into trainer_subscription_accounts (trainer_id, stripe_customer_id, stripe_subscription_id, status)
     values ($1, $2, $3, 'active')`,
    [trainerId, `cus_fixture${fixtureCounter}${Date.now()}`, `sub_fixture${fixtureCounter}${Date.now()}`],
  );
  const program = await pool.query(
    `insert into programs (trainer_id, slug, title, price_cents, currency, duration_value, duration_unit, status, published_at)
     values ($1, $2, '8-week cut', 19900, 'usd', 8, 'week', 'published', now())
     returning id`,
    [trainerId, `cut-${fixtureCounter}-${Date.now()}`],
  );
  return { trainerId, programId: program.rows[0].id as string };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}
