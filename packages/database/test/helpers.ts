import pg from "pg";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/fitmarket_test";

/**
 * Test harness emulating Supabase's request model:
 *  - `admin` runs as the postgres superuser (like the service_role path).
 *  - `as(userId)` runs a callback inside a transaction with
 *    `set local role authenticated` and JWT claims, exactly how PostgREST
 *    executes client queries — RLS applies.
 *  - `asAnon(...)` does the same with the anon role and no claims.
 */
export class Db {
  private pool: pg.Pool;

  constructor(url = TEST_DATABASE_URL) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }

  async admin(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
    return this.pool.query(text, params);
  }

  async as<T>(
    userId: string,
    fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
      const result = await fn((text, params = []) => client.query(text, params));
      await client.query("rollback"); // tests never persist client-role writes
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Like `as` but COMMITS the transaction (for write-path tests). */
  async asCommitted<T>(
    userId: string,
    fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
      const result = await fn((text, params = []) => client.query(text, params));
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async asAnon<T>(
    fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role anon");
      const result = await fn((text, params = []) => client.query(text, params));
      await client.query("rollback");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let userCounter = 0;

/** Creates an auth user; the signup trigger provisions public rows. */
export async function createUser(db: Db, emailPrefix: string): Promise<string> {
  userCounter += 1;
  const email = `${emailPrefix}-${Date.now()}-${userCounter}@test.invalid`;
  const res = await db.admin(
    `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
    [email],
  );
  return res.rows[0].id as string;
}

export async function makeTrainer(
  db: Db,
  userId: string,
  opts: { isPublic?: boolean; slug?: string } = {},
): Promise<void> {
  await db.admin(`insert into public.user_roles (user_id, role) values ($1, 'trainer')`, [userId]);
  await db.admin(
    `insert into public.trainer_profiles
       (user_id, slug, headline, about, service_mode, application_status, is_public, approved_at)
     values ($1, $2, 'Certified coach with results', 'About text for coach', 'hybrid',
             'approved', $3, now())`,
    [userId, opts.slug ?? `coach-${userId.slice(0, 8)}`, opts.isPublic ?? true],
  );
}

export interface ActiveEnrollmentFixture {
  programId: string;
  snapshotId: string;
  orderId: string;
  enrollmentId: string;
  conversationId: string;
}

/** Full server-side purchase fixture: program -> order(paid) -> active enrollment
 *  with entitlements and a conversation. Mirrors what services/api does after a
 *  verified webhook. */
export async function createActiveEnrollment(
  db: Db,
  trainerId: string,
  clientId: string,
  opts: { accessEndsAt?: string; entitlementEndsAt?: string | null } = {},
): Promise<ActiveEnrollmentFixture> {
  const program = await db.admin(
    `insert into public.programs
       (trainer_id, slug, title, price_cents, currency, duration_value, duration_unit, status, published_at)
     values ($1, $2, '12-week strength', 25000, 'usd', 12, 'week', 'published', now())
     returning id, version`,
    [trainerId, `prog-${Math.random().toString(36).slice(2, 10)}`],
  );
  const programId = program.rows[0].id as string;
  const versionRow = await db.admin(
    `select id from public.program_versions where program_id = $1 and version = $2`,
    [programId, program.rows[0].version],
  );
  const snapshot = await db.admin(
    `insert into public.program_purchase_snapshots
       (program_id, program_version_id, trainer_id, title, price_cents, currency,
        duration_value, duration_unit, pricing_type, delivery_mode)
     values ($1, $2, $3, '12-week strength', 25000, 'usd', 12, 'week', 'one_time', 'online')
     returning id`,
    [programId, versionRow.rows[0].id, trainerId],
  );
  const snapshotId = snapshot.rows[0].id as string;
  const order = await db.admin(
    `insert into public.orders
       (client_id, trainer_id, program_id, purchase_snapshot_id, status, amount_cents,
        currency, idempotency_key, paid_at)
     values ($1, $2, $3, $4, 'created', 25000, 'usd', $5, now())
     returning id`,
    [clientId, trainerId, programId, snapshotId, `order-${Math.random().toString(36).slice(2)}`],
  );
  const orderId = order.rows[0].id as string;
  await db.admin(`update public.orders set status='awaiting_payment' where id=$1`, [orderId]);
  await db.admin(`update public.orders set status='paid' where id=$1`, [orderId]);

  const accessEndsAt = opts.accessEndsAt ?? new Date(Date.now() + 84 * 86400_000).toISOString();
  const enrollment = await db.admin(
    `insert into public.enrollments
       (client_id, trainer_id, program_id, purchase_snapshot_id, order_id, status,
        actual_start_at, access_ends_at)
     values ($1, $2, $3, $4, $5, 'pending_payment', now(), $6)
     returning id`,
    [clientId, trainerId, programId, snapshotId, orderId, accessEndsAt],
  );
  const enrollmentId = enrollment.rows[0].id as string;
  await db.admin(`update public.enrollments set status='active' where id=$1`, [enrollmentId]);

  const entitlementEnd =
    opts.entitlementEndsAt === undefined ? accessEndsAt : opts.entitlementEndsAt;
  for (const type of ["program_content", "messaging", "review"]) {
    await db.admin(
      `insert into public.entitlements (enrollment_id, client_id, trainer_id, type, status, ends_at)
       values ($1, $2, $3, $4, 'active', $5)`,
      [enrollmentId, clientId, trainerId, type, entitlementEnd],
    );
  }

  const conversation = await db.admin(
    `insert into public.conversations (enrollment_id, kind, client_id, trainer_id, status)
     values ($1, 'enrollment', $2, $3, 'active') returning id`,
    [enrollmentId, clientId, trainerId],
  );
  const conversationId = conversation.rows[0].id as string;
  for (const [uid, role] of [
    [clientId, "client"],
    [trainerId, "trainer"],
  ] as const) {
    await db.admin(
      `insert into public.conversation_participants (conversation_id, user_id, role)
       values ($1, $2, $3)`,
      [conversationId, uid, role],
    );
  }
  return { programId, snapshotId, orderId, enrollmentId, conversationId };
}
