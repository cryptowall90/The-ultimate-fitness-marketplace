import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsDir = join(here, "..", "migrations");
export const localShimPath = join(here, "..", "migrations-local", "0000_supabase_shim.sql");
export const seedsDir = join(here, "..", "seeds");

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (e.g. postgres://postgres@127.0.0.1:54329/fitmarket)");
  }
  return url;
}

async function sqlFiles(dir: string): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Applies the local Supabase shim when the `auth` schema is absent (i.e. we are on a
 * plain PostgreSQL, not on Supabase). On Supabase the auth schema and the anon /
 * authenticated / service_role roles already exist and the shim is skipped.
 */
async function ensureSupabaseCompat(client: pg.Client): Promise<void> {
  const res = await client.query(
    "select 1 from information_schema.schemata where schema_name = 'auth'",
  );
  if (res.rowCount === 0) {
    const shim = await readFile(localShimPath, "utf8");
    await client.query(shim);
  }
}

export async function migrate(url = databaseUrl()): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await ensureSupabaseCompat(client);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    // Migration bookkeeping is never client-accessible.
    await client.query("alter table schema_migrations enable row level security");
    await client.query(
      "revoke all on table schema_migrations from anon, authenticated",
    );
    const done = new Set(
      (await client.query("select name from schema_migrations")).rows.map((r) => r.name as string),
    );
    for (const file of await sqlFiles(migrationsDir)) {
      if (done.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

export async function seed(url = databaseUrl()): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    for (const file of await sqlFiles(seedsDir)) {
      const sql = await readFile(join(seedsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Seed ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** Drops and recreates the target database, then migrates. Local development only. */
export async function reset(url = databaseUrl()): Promise<void> {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) throw new Error("DATABASE_URL must include a database name");
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to reset a production database");
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${pg.escapeIdentifier(dbName)} with (force)`);
    await admin.query(`create database ${pg.escapeIdentifier(dbName)}`);
  } finally {
    await admin.end();
  }
  await migrate(url);
}
