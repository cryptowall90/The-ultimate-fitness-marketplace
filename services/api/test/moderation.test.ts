import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSellableTrainer,
  createTestApp,
  createUser,
  signAccessToken,
  type TestApp,
  type TrainerFixture,
  json,
} from "./helpers.js";

let t: TestApp;
let moderator: string;
let regularUser: string;
let client: string;
let fixture: TrainerFixture;

beforeAll(async () => {
  t = createTestApp();
  moderator = await createUser(t.pool, "mod");
  await t.pool.query(`insert into user_roles (user_id, role) values ($1, 'moderator')`, [
    moderator,
  ]);
  regularUser = await createUser(t.pool, "mod-regular");
  client = await createUser(t.pool, "mod-client");
  fixture = await createSellableTrainer(t.pool);
});

afterAll(async () => {
  await t.close();
});

/** Published review via direct insert (service context bypasses RLS). */
async function createReview(comment: string): Promise<string> {
  const versionRes = await t.pool.query(
    `select id from program_versions where program_id = $1 order by version desc limit 1`,
    [fixture.programId],
  );
  const snapshot = await t.pool.query(
    `insert into program_purchase_snapshots
       (program_id, program_version_id, trainer_id, title, price_cents, currency,
        duration_value, duration_unit, pricing_type, delivery_mode)
     values ($1, $2, $3, 'Mod fixture', 19900, 'usd', 8, 'week', 'one_time', 'online')
     returning id`,
    [fixture.programId, versionRes.rows[0].id, fixture.trainerId],
  );
  const enrollment = await t.pool.query(
    `insert into enrollments (client_id, trainer_id, program_id, purchase_snapshot_id, status)
     values ($1, $2, $3, $4, 'active') returning id`,
    [client, fixture.trainerId, fixture.programId, snapshot.rows[0].id],
  );
  const review = await t.pool.query(
    `insert into reviews (reviewer_client_id, trainer_id, enrollment_id, rating, comment)
     values ($1, $2, $3, 1, $4) returning id`,
    [client, fixture.trainerId, enrollment.rows[0].id, comment],
  );
  await t.pool.query(`select app.recompute_trainer_rating($1)`, [fixture.trainerId]);
  return review.rows[0].id as string;
}

async function createReport(targetType: string, targetId: string): Promise<string> {
  const res = await t.pool.query(
    `insert into reports (reporter_id, target_type, target_id, reason)
     values ($1, $2, $3, 'abusive content reported in test') returning id`,
    [regularUser, targetType, targetId],
  );
  return res.rows[0].id as string;
}

async function modPost(path: string, body: object, userId = moderator): Promise<Response> {
  return t.app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await signAccessToken(userId)}`,
    },
  });
}

describe("moderation endpoints", () => {
  it("rejects unauthenticated and non-moderator users", async () => {
    const anon = await t.app.request("/v1/moderation/reports");
    expect(anon.status).toBe(401);

    const regular = await t.app.request("/v1/moderation/reports", {
      headers: { authorization: `Bearer ${await signAccessToken(regularUser)}` },
    });
    expect(regular.status).toBe(403);
  });

  it("lists open reports with a content preview for reviews", async () => {
    const reviewId = await createReview("this trainer was terrible!!");
    const reportId = await createReport("review", reviewId);

    const res = await t.app.request("/v1/moderation/reports", {
      headers: { authorization: `Bearer ${await signAccessToken(moderator)}` },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const entry = body.reports.find((r: { id: string }) => r.id === reportId);
    expect(entry).toBeDefined();
    expect(entry.targetType).toBe("review");
    expect(entry.content).toBe("this trainer was terrible!!");
  });

  it("dismisses a report and records the decision", async () => {
    const reviewId = await createReview("fine review, spurious report");
    const reportId = await createReport("review", reviewId);

    const res = await modPost(`/v1/moderation/reports/${reportId}/dismiss`, {
      reason: "Report is unfounded",
    });
    expect(res.status).toBe(200);

    const report = await t.pool.query(`select status from reports where id = $1`, [reportId]);
    expect(report.rows[0].status).toBe("dismissed");

    const review = await t.pool.query(`select moderation_status from reviews where id = $1`, [
      reviewId,
    ]);
    expect(review.rows[0].moderation_status).toBe("published"); // untouched

    const audit = await t.pool.query(
      `select 1 from admin_actions where action = 'report.dismiss' and target_id = $1`,
      [reportId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("actions a review report with removal and recomputes ratings", async () => {
    const reviewId = await createReview("actually abusive review body");
    const reportId = await createReport("review", reviewId);
    const before = await t.pool.query(
      `select review_count from trainer_rating_summaries where trainer_id = $1`,
      [fixture.trainerId],
    );

    const res = await modPost(`/v1/moderation/reports/${reportId}/action`, {
      reason: "Violates review policy",
      removeContent: true,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ reportId, status: "actioned", contentRemoved: true });

    const review = await t.pool.query(
      `select moderation_status, removal_reason from reviews where id = $1`,
      [reviewId],
    );
    expect(review.rows[0].moderation_status).toBe("removed");
    expect(review.rows[0].removal_reason).toBe("Violates review policy");

    const after = await t.pool.query(
      `select review_count from trainer_rating_summaries where trainer_id = $1`,
      [fixture.trainerId],
    );
    expect(after.rows[0].review_count).toBe(before.rows[0].review_count - 1);

    const audit = await t.pool.query(
      `select metadata from admin_actions where action = 'report.action' and target_id = $1`,
      [reportId],
    );
    expect(audit.rows[0].metadata).toEqual({ contentRemoved: true });

    // Deciding the same report again conflicts.
    const again = await modPost(`/v1/moderation/reports/${reportId}/dismiss`, {
      reason: "duplicate decision",
    });
    expect(again.status).toBe(409);
  });

  it("refuses content removal for unsupported targets", async () => {
    const reportId = await createReport("trainer_profile", fixture.trainerId);
    const res = await modPost(`/v1/moderation/reports/${reportId}/action`, {
      reason: "Profile issue",
      removeContent: true,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("remove_not_supported");

    // Without removal the same report can still be actioned.
    const ok = await modPost(`/v1/moderation/reports/${reportId}/action`, {
      reason: "Handled manually",
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).contentRemoved).toBe(false);
  });
});
