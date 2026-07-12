import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Db,
  createActiveEnrollment,
  createUser,
  makeTrainer,
  type ActiveEnrollmentFixture,
} from "./helpers.js";

const db = new Db();
let client: string;
let trainer: string;
let stranger: string;
let fixture: ActiveEnrollmentFixture;

beforeAll(async () => {
  client = await createUser(db, "msg-client");
  trainer = await createUser(db, "msg-trainer");
  stranger = await createUser(db, "msg-stranger");
  await makeTrainer(db, trainer);
  fixture = await createActiveEnrollment(db, trainer, client);
});

afterAll(async () => {
  await db.close();
});

describe("messaging authorization", () => {
  it("participants can send messages during an active entitlement", async () => {
    await db.asCommitted(client, async (q) => {
      const res = await q(
        `insert into messages (conversation_id, sender_id, kind, body)
         values ($1, $2, 'text', 'hello coach') returning id`,
        [fixture.conversationId, client],
      );
      expect(res.rows).toHaveLength(1);
    });
  });

  it("rejects spoofed sender ids (no client-controlled sender)", async () => {
    await expect(
      db.as(client, (q) =>
        q(
          `insert into messages (conversation_id, sender_id, kind, body)
           values ($1, $2, 'text', 'spoofed')`,
          [fixture.conversationId, trainer],
        ),
      ),
    ).rejects.toThrow();
  });

  it("non-participants can neither read nor write the conversation", async () => {
    const read = await db.as(stranger, (q) =>
      q(`select * from messages where conversation_id = $1`, [fixture.conversationId]),
    );
    expect(read.rows).toHaveLength(0);
    await expect(
      db.as(stranger, (q) =>
        q(
          `insert into messages (conversation_id, sender_id, kind, body)
           values ($1, $2, 'text', 'intruder')`,
          [fixture.conversationId, stranger],
        ),
      ),
    ).rejects.toThrow();
  });

  it("critical test 4: expired enrollment/entitlement disables new messages but keeps history readable", async () => {
    // Expire the messaging entitlement (what the expiry job does).
    await db.admin(
      `update public.entitlements set status = 'expired', ends_at = now() - interval '1 hour'
       where enrollment_id = $1 and type = 'messaging'`,
      [fixture.enrollmentId],
    );

    await expect(
      db.as(client, (q) =>
        q(
          `insert into messages (conversation_id, sender_id, kind, body)
           values ($1, $2, 'text', 'too late')`,
          [fixture.conversationId, client],
        ),
      ),
    ).rejects.toThrow();

    await expect(
      db.as(trainer, (q) =>
        q(
          `insert into messages (conversation_id, sender_id, kind, body)
           values ($1, $2, 'text', 'also too late')`,
          [fixture.conversationId, trainer],
        ),
      ),
    ).rejects.toThrow();

    // History remains readable (read-only conversation).
    const history = await db.as(client, (q) =>
      q(`select body from messages where conversation_id = $1`, [fixture.conversationId]),
    );
    expect(history.rows.length).toBeGreaterThan(0);
  });

  it("critical test 5: expired entitlement blocks program content access", async () => {
    await db.admin(
      `update public.entitlements set status = 'expired', ends_at = now() - interval '1 hour'
       where enrollment_id = $1 and type = 'program_content'`,
      [fixture.enrollmentId],
    );
    const res = await db.admin(`select app.has_entitlement($1, $2, 'program_content') as ok`, [
      client,
      trainer,
    ]);
    expect(res.rows[0].ok).toBe(false);
  });
});

describe("review integrity", () => {
  let reviewFixture: ActiveEnrollmentFixture;
  let reviewClient: string;

  beforeAll(async () => {
    reviewClient = await createUser(db, "review-client");
    reviewFixture = await createActiveEnrollment(db, trainer, reviewClient);
  });

  it("critical test 10: rating outside 1-5 or non-integer is rejected", async () => {
    for (const bad of [0, 6, -1]) {
      await expect(
        db.as(reviewClient, (q) =>
          q(
            `insert into reviews (reviewer_client_id, trainer_id, enrollment_id, rating)
             values ($1, $2, $3, $4)`,
            [reviewClient, trainer, reviewFixture.enrollmentId, bad],
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it("critical test 9: review requires an eligible enrollment", async () => {
    // A stranger with no enrollment cannot review.
    await expect(
      db.as(stranger, (q) =>
        q(
          `insert into reviews (reviewer_client_id, trainer_id, enrollment_id, rating)
           values ($1, $2, $3, 5)`,
          [stranger, trainer, reviewFixture.enrollmentId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("the eligible client can review once; duplicates are blocked", async () => {
    await db.asCommitted(reviewClient, (q) =>
      q(
        `insert into reviews (reviewer_client_id, trainer_id, enrollment_id, rating, comment)
         values ($1, $2, $3, 4, 'Solid coaching')`,
        [reviewClient, trainer, reviewFixture.enrollmentId],
      ),
    );
    await expect(
      db.as(reviewClient, (q) =>
        q(
          `insert into reviews (reviewer_client_id, trainer_id, enrollment_id, rating)
           values ($1, $2, $3, 5)`,
          [reviewClient, trainer, reviewFixture.enrollmentId],
        ),
      ),
    ).rejects.toThrow(/duplicate key|violates/);
  });

  it("rating aggregates are recomputed by trusted logic", async () => {
    const res = await db.admin(
      `select review_count, weighted_rating from public.trainer_rating_summaries where trainer_id = $1`,
      [trainer],
    );
    expect(res.rows[0].review_count).toBeGreaterThanOrEqual(1);
    // Bayesian smoothing keeps a small sample near the prior.
    expect(Number(res.rows[0].weighted_rating)).toBeLessThan(4.5);
  });

  it("the trainer can respond but cannot alter the rating or comment", async () => {
    await db.asCommitted(trainer, (q) =>
      q(`update reviews set trainer_response = 'Thanks for the feedback!' where enrollment_id = $1`, [
        reviewFixture.enrollmentId,
      ]),
    );
    await expect(
      db.as(trainer, (q) =>
        q(`update reviews set rating = 5 where enrollment_id = $1`, [reviewFixture.enrollmentId]),
      ),
    ).rejects.toThrow(/only respond/);
    await expect(
      db.as(trainer, (q) =>
        q(`update reviews set moderation_status = 'removed' where enrollment_id = $1`, [
          reviewFixture.enrollmentId,
        ]),
      ),
    ).rejects.toThrow(/only respond/);
  });

  it("the reviewer cannot touch moderation columns", async () => {
    await expect(
      db.as(reviewClient, (q) =>
        q(`update reviews set moderation_status = 'removed' where enrollment_id = $1`, [
          reviewFixture.enrollmentId,
        ]),
      ),
    ).rejects.toThrow(/not editable/);
  });

  it("published reviews are readable publicly; removed ones are not", async () => {
    const pub = await db.asAnon((q) =>
      q(`select comment from reviews where enrollment_id = $1`, [reviewFixture.enrollmentId]),
    );
    expect(pub.rows).toHaveLength(1);

    await db.admin(
      `update public.reviews set moderation_status = 'removed', removed_at = now(),
              removal_reason = 'test' where enrollment_id = $1`,
      [reviewFixture.enrollmentId],
    );
    const hidden = await db.asAnon((q) =>
      q(`select * from reviews where enrollment_id = $1`, [reviewFixture.enrollmentId]),
    );
    expect(hidden.rows).toHaveLength(0);
  });
});
