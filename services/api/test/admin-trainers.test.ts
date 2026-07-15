import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createUser, json, signAccessToken, type TestApp } from "./helpers.js";

let t: TestApp;
let admin: string;
let regular: string;

beforeAll(async () => {
  t = createTestApp();
  admin = await createUser(t.pool, "admin");
  await t.pool.query(`insert into user_roles (user_id, role) values ($1, 'admin')`, [admin]);
  regular = await createUser(t.pool, "regular");
});

afterAll(async () => {
  await t.close();
});

let applicantCounter = 0;

async function createApplicant(status = "submitted"): Promise<string> {
  applicantCounter += 1;
  const userId = await createUser(t.pool, "applicant");
  await t.pool.query(
    `insert into trainer_profiles
       (user_id, slug, headline, about, service_mode, years_experience, languages,
        application_status, application_submitted_at)
     values ($1, $2, 'Strength coach for busy parents', 'Long about text', 'online', 5,
             '{English}', $3, now())`,
    [userId, `applicant-${applicantCounter}-${Date.now()}`, status],
  );
  return userId;
}

describe("admin trainer application list", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await t.app.request("/v1/admin/trainer-applications");
    expect(res.status).toBe(401);
  });

  it("rejects authenticated non-admin users", async () => {
    const token = await signAccessToken(regular);
    const res = await t.app.request("/v1/admin/trainer-applications", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("lists submitted applications for admins", async () => {
    const applicant = await createApplicant();
    const token = await signAccessToken(admin);
    const res = await t.app.request("/v1/admin/trainer-applications", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const entry = body.applications.find((a: { trainerId: string }) => a.trainerId === applicant);
    expect(entry).toBeDefined();
    expect(entry.applicationStatus).toBe("submitted");
    expect(entry.headline).toBe("Strength coach for busy parents");
  });

  it("rejects invalid status filters", async () => {
    const token = await signAccessToken(admin);
    const res = await t.app.request("/v1/admin/trainer-applications?status=approved", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("admin trainer application decision", () => {
  async function decide(token: string, payload: Record<string, unknown>): Promise<Response> {
    return t.app.request("/v1/admin/trainer-applications/decision", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
  }

  it("rejects non-admin users", async () => {
    const applicant = await createApplicant();
    const token = await signAccessToken(regular);
    const res = await decide(token, {
      trainerId: applicant,
      decision: "approved",
      reason: "looks good",
    });
    expect(res.status).toBe(403);
  });

  it("rejects unknown fields (mass-assignment protection)", async () => {
    const applicant = await createApplicant();
    const token = await signAccessToken(admin);
    const res = await decide(token, {
      trainerId: applicant,
      decision: "approved",
      reason: "looks good",
      isPublic: false,
    });
    expect(res.status).toBe(400);
  });

  it("approves: sets status, grants trainer role, publishes, audits", async () => {
    const applicant = await createApplicant();
    const token = await signAccessToken(admin);
    const res = await decide(token, {
      trainerId: applicant,
      decision: "approved",
      reason: "credentials verified",
    });
    expect(res.status).toBe(200);

    const profile = await t.pool.query(
      `select application_status, approved_at, approved_by, is_public, rejection_reason
       from trainer_profiles where user_id = $1`,
      [applicant],
    );
    expect(profile.rows[0].application_status).toBe("approved");
    expect(profile.rows[0].approved_by).toBe(admin);
    expect(profile.rows[0].is_public).toBe(true);
    expect(profile.rows[0].rejection_reason).toBeNull();

    const role = await t.pool.query(
      `select 1 from user_roles where user_id = $1 and role = 'trainer'`,
      [applicant],
    );
    expect(role.rowCount).toBe(1);

    const audit = await t.pool.query(
      `select actor_id, reason from admin_actions
       where action = 'trainer_application_approved' and target_id = $1`,
      [applicant],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(admin);
    expect(audit.rows[0].reason).toBe("credentials verified");
  });

  it("rejects: records the reason, stays unpublished, audits", async () => {
    const applicant = await createApplicant();
    const token = await signAccessToken(admin);
    const res = await decide(token, {
      trainerId: applicant,
      decision: "rejected",
      reason: "certification could not be verified",
    });
    expect(res.status).toBe(200);

    const profile = await t.pool.query(
      `select application_status, is_public, rejection_reason from trainer_profiles
       where user_id = $1`,
      [applicant],
    );
    expect(profile.rows[0].application_status).toBe("rejected");
    expect(profile.rows[0].is_public).toBe(false);
    expect(profile.rows[0].rejection_reason).toBe("certification could not be verified");

    const role = await t.pool.query(
      `select 1 from user_roles where user_id = $1 and role = 'trainer'`,
      [applicant],
    );
    expect(role.rowCount).toBe(0);

    const audit = await t.pool.query(
      `select 1 from admin_actions
       where action = 'trainer_application_rejected' and target_id = $1`,
      [applicant],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("returns 409 when the application is not in a decidable state", async () => {
    const applicant = await createApplicant("draft");
    const token = await signAccessToken(admin);
    const res = await decide(token, {
      trainerId: applicant,
      decision: "approved",
      reason: "premature",
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for unknown applications", async () => {
    const token = await signAccessToken(admin);
    const res = await decide(token, {
      trainerId: "00000000-0000-4000-8000-000000000000",
      decision: "approved",
      reason: "who is this",
    });
    expect(res.status).toBe(404);
  });
});
