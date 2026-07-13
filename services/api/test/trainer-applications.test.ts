import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createUser, signAccessToken, type TestApp, json } from "./helpers.js";

let t: TestApp;
let admin: string;
let regularUser: string;

beforeAll(async () => {
  t = createTestApp();
  admin = await createUser(t.pool, "admin");
  await t.pool.query(`insert into user_roles (user_id, role) values ($1, 'admin')`, [admin]);
  regularUser = await createUser(t.pool, "regular");
});

afterAll(async () => {
  await t.close();
});

async function createSubmittedApplicant(slugPrefix: string): Promise<string> {
  const userId = await createUser(t.pool, "applicant");
  await t.pool.query(`update profiles set display_name = 'Applicant Person' where user_id = $1`, [
    userId,
  ]);
  await t.pool.query(
    `insert into trainer_profiles
       (user_id, slug, headline, about, application_status, application_submitted_at)
     values ($1, $2, 'Strength coach for busy people', 'Long about text', 'submitted', now())`,
    [userId, `${slugPrefix}-${Date.now()}`],
  );
  await t.pool.query(
    `insert into trainer_credentials (trainer_id, title, issuing_organization)
     values ($1, 'CPT', 'NASM')`,
    [userId],
  );
  return userId;
}

async function adminPost(path: string, body: object, token: string): Promise<Response> {
  return t.app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
}

describe("admin trainer application review", () => {
  it("rejects unauthenticated list requests", async () => {
    const res = await t.app.request("/v1/admin/trainer-applications");
    expect(res.status).toBe(401);
  });

  it("rejects authenticated non-admin users", async () => {
    const token = await signAccessToken(regularUser);
    const res = await t.app.request("/v1/admin/trainer-applications", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);

    const approve = await adminPost(
      `/v1/admin/trainer-applications/${regularUser}/approve`,
      { reason: "should not work" },
      token,
    );
    expect(approve.status).toBe(403);
  });

  it("lists submitted applications with credentials", async () => {
    const applicant = await createSubmittedApplicant("list-me");
    const token = await signAccessToken(admin);
    const res = await t.app.request("/v1/admin/trainer-applications", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const entry = body.applications.find((a: { trainerId: string }) => a.trainerId === applicant);
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("Applicant Person");
    expect(entry.credentials).toEqual([
      expect.objectContaining({ title: "CPT", issuingOrganization: "NASM", status: "pending" }),
    ]);
  });

  it("approves an application: status, trainer role, public flag, audit row", async () => {
    const applicant = await createSubmittedApplicant("approve-me");
    const token = await signAccessToken(admin);
    const res = await adminPost(
      `/v1/admin/trainer-applications/${applicant}/approve`,
      { reason: "Credentials verified manually" },
      token,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ trainerId: applicant, status: "approved" });

    const profile = await t.pool.query(
      `select application_status, approved_by, approved_at, is_public
       from trainer_profiles where user_id = $1`,
      [applicant],
    );
    expect(profile.rows[0].application_status).toBe("approved");
    expect(profile.rows[0].approved_by).toBe(admin);
    expect(profile.rows[0].approved_at).not.toBeNull();
    expect(profile.rows[0].is_public).toBe(true);

    const role = await t.pool.query(
      `select granted_by from user_roles where user_id = $1 and role = 'trainer'`,
      [applicant],
    );
    expect(role.rows[0]?.granted_by).toBe(admin);

    const audit = await t.pool.query(
      `select actor_id, reason from admin_actions
       where action = 'trainer_application.approve' and target_id = $1`,
      [applicant],
    );
    expect(audit.rows).toEqual([{ actor_id: admin, reason: "Credentials verified manually" }]);
  });

  it("rejects an application with a visible reason and audit row", async () => {
    const applicant = await createSubmittedApplicant("reject-me");
    const token = await signAccessToken(admin);
    const res = await adminPost(
      `/v1/admin/trainer-applications/${applicant}/reject`,
      { reason: "Credential could not be verified" },
      token,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ trainerId: applicant, status: "rejected" });

    const profile = await t.pool.query(
      `select application_status, rejection_reason, is_public
       from trainer_profiles where user_id = $1`,
      [applicant],
    );
    expect(profile.rows[0].application_status).toBe("rejected");
    expect(profile.rows[0].rejection_reason).toBe("Credential could not be verified");
    expect(profile.rows[0].is_public).toBe(false);

    const audit = await t.pool.query(
      `select 1 from admin_actions where action = 'trainer_application.reject' and target_id = $1`,
      [applicant],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("refuses decisions on applications not awaiting review", async () => {
    const applicant = await createSubmittedApplicant("decide-twice");
    const token = await signAccessToken(admin);
    const first = await adminPost(
      `/v1/admin/trainer-applications/${applicant}/approve`,
      { reason: "Approved once" },
      token,
    );
    expect(first.status).toBe(200);

    const again = await adminPost(
      `/v1/admin/trainer-applications/${applicant}/reject`,
      { reason: "Cannot reject after approval" },
      token,
    );
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("invalid_status");
  });

  it("returns 404 for unknown applications and 400 for invalid bodies", async () => {
    const token = await signAccessToken(admin);
    const missing = await adminPost(
      `/v1/admin/trainer-applications/00000000-0000-4000-8000-000000000000/approve`,
      { reason: "No such profile" },
      token,
    );
    expect(missing.status).toBe(404);

    const applicant = await createSubmittedApplicant("bad-body");
    const noReason = await adminPost(
      `/v1/admin/trainer-applications/${applicant}/approve`,
      {},
      token,
    );
    expect(noReason.status).toBe(400);

    const extraField = await adminPost(
      `/v1/admin/trainer-applications/${applicant}/approve`,
      { reason: "valid reason", extra: "nope" },
      token,
    );
    expect(extraField.status).toBe(400);
  });
});
