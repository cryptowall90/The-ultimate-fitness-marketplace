import pg from "pg";
import { migrate, seed } from "@fitmarket/database";

export const API_TEST_DATABASE_URL =
  process.env.API_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/fitmarket_api_test";

export default async function globalSetup(): Promise<void> {
  const adminUrl = new URL(API_TEST_DATABASE_URL);
  const dbName = adminUrl.pathname.replace(/^\//, "");
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${pg.escapeIdentifier(dbName)} with (force)`);
    await admin.query(`create database ${pg.escapeIdentifier(dbName)}`);
  } finally {
    await admin.end();
  }
  await migrate(API_TEST_DATABASE_URL);
  await seed(API_TEST_DATABASE_URL);
}
