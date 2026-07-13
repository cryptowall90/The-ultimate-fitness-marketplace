import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db, createActiveEnrollment, createUser, makeTrainer } from "./helpers.js";

const db = new Db();
let clientA: string;
let clientB: string;
let trainerA: string;
let trainerB: string;
let outsider: string;

beforeAll(async () => {
  clientA = await createUser(db, "client-a");
  clientB = await createUser(db, "client-b");
  outsider = await createUser(db, "outsider");
  trainerA = await createUser(db, "trainer-a");
  trainerB = await createUser(db, "trainer-b");
  await makeTrainer(db, trainerA);
  await makeTrainer(db, trainerB);
  await db.admin(
    `update public.client_profiles set fitness_goals = 'clientA private goals' where user_id = $1`,
    [clientA],
  );
});

afterAll(async () => {
  await db.close();
});

describe("critical test 1: client A cannot read client B's private record", () => {
  it("client_profiles are self-only for unrelated users", async () => {
    const own = await db.as(clientA, (q) =>
      q(`select fitness_goals from client_profiles where user_id = $1`, [clientA]),
    );
    expect(own.rows).toHaveLength(1);

    const cross = await db.as(clientB, (q) =>
      q(`select * from client_profiles where user_id = $1`, [clientA]),
    );
    expect(cross.rows).toHaveLength(0);
  });

  it("cross-tenant UPDATE writes zero rows", async () => {
    const result = await db.as(clientB, (q) =>
      q(`update client_profiles set fitness_goals = 'hacked' where user_id = $1`, [clientA]),
    );
    expect(result.rowCount).toBe(0);
  });
});

describe("critical tests 2-3: trainer-client isolation", () => {
  it("trainer cannot read a client's profile before any relationship exists", async () => {
    const rows = await db.as(trainerA, (q) =>
      q(`select * from client_profiles where user_id = $1`, [clientA]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("trainer with a relationship can read; an unrelated trainer cannot", async () => {
    await createActiveEnrollment(db, trainerA, clientA);
    const related = await db.as(trainerA, (q) =>
      q(`select fitness_goals from client_profiles where user_id = $1`, [clientA]),
    );
    expect(related.rows).toHaveLength(1);

    const unrelated = await db.as(trainerB, (q) =>
      q(`select * from client_profiles where user_id = $1`, [clientA]),
    );
    expect(unrelated.rows).toHaveLength(0);
  });

  it("trainer A cannot read trainer B's CRM records or private notes", async () => {
    await createActiveEnrollment(db, trainerB, clientB);
    await db.admin(
      `insert into public.crm_client_records (trainer_id, client_id) values ($1, $2)
       on conflict do nothing`,
      [trainerB, clientB],
    );
    await db.admin(
      `insert into public.trainer_notes (trainer_id, client_id, body)
       values ($1, $2, 'trainer B private note about client B')`,
      [trainerB, clientB],
    );

    const crm = await db.as(trainerA, (q) =>
      q(`select * from crm_client_records where trainer_id = $1`, [trainerB]),
    );
    expect(crm.rows).toHaveLength(0);

    const notes = await db.as(trainerA, (q) => q(`select * from trainer_notes`));
    expect(notes.rows.every((r) => r.trainer_id === trainerA)).toBe(true);
    expect(notes.rows.find((r) => r.body?.includes("trainer B private"))).toBeUndefined();
  });

  it("clients can never read trainer private notes about them", async () => {
    const rows = await db.as(clientB, (q) => q(`select * from trainer_notes`));
    expect(rows.rows).toHaveLength(0);
  });

  it("trainer cannot read another trainer's billing ledger or payouts", async () => {
    const ledger = await db.as(trainerA, (q) =>
      q(`select * from active_client_billing_ledger where trainer_id = $1`, [trainerB]),
    );
    expect(ledger.rows).toHaveLength(0);
  });
});

describe("critical test 11: private progress photos", () => {
  let mediaId: string;

  beforeAll(async () => {
    const media = await db.admin(
      `insert into public.media_objects
         (owner_id, provider, bucket, object_key, visibility, status, mime_type)
       values ($1, 'supabase_storage', 'progress', 'progress/ab/testkey12345', 'private_progress',
               'published', 'image/jpeg')
       returning id`,
      [clientA],
    );
    mediaId = media.rows[0].id as string;
    await db.admin(
      `insert into public.progress_photos (client_id, media_id, shared_with_trainer)
       values ($1, $2, false)`,
      [clientA, mediaId],
    );
  });

  it("an unrelated user cannot see the photo row or media object", async () => {
    const photos = await db.as(outsider, (q) =>
      q(`select * from progress_photos where client_id = $1`, [clientA]),
    );
    expect(photos.rows).toHaveLength(0);
    const media = await db.as(outsider, (q) =>
      q(`select * from media_objects where id = $1`, [mediaId]),
    );
    expect(media.rows).toHaveLength(0);
  });

  it("the trainer cannot see it until the client shares it", async () => {
    const before = await db.as(trainerA, (q) =>
      q(`select * from progress_photos where client_id = $1`, [clientA]),
    );
    expect(before.rows).toHaveLength(0);

    await db.admin(
      `update public.progress_photos set shared_with_trainer = true where media_id = $1`,
      [mediaId],
    );
    const after = await db.as(trainerA, (q) =>
      q(`select * from progress_photos where client_id = $1`, [clientA]),
    );
    expect(after.rows).toHaveLength(1);

    const otherTrainer = await db.as(trainerB, (q) =>
      q(`select * from progress_photos where client_id = $1`, [clientA]),
    );
    expect(otherTrainer.rows).toHaveLength(0);
  });
});

describe("critical test 13: trainer home address is not exposed", () => {
  beforeAll(async () => {
    await db.admin(
      `insert into public.trainer_service_locations
         (trainer_id, city_name, country_code, public_point, exact_location, exact_address,
          service_area_label, is_primary)
       values ($1, 'Austin', 'US',
               st_setsrid(st_makepoint(-97.7431, 30.2672), 4326)::geography,
               st_setsrid(st_makepoint(-97.7440, 30.2680), 4326)::geography,
               '123 Secret Home St', 'Central Austin', true)`,
      [trainerA],
    );
  });

  it("anon users cannot select trainer_service_locations at all", async () => {
    const rows = await db.asAnon((q) => q(`select * from trainer_service_locations`));
    expect(rows.rows).toHaveLength(0);
  });

  it("other authenticated users cannot read exact locations", async () => {
    const rows = await db.as(clientA, (q) => q(`select * from trainer_service_locations`));
    expect(rows.rows).toHaveLength(0);
  });

  it("the search function returns safe columns only", async () => {
    const result = await db.asAnon((q) =>
      q(`select * from app.search_trainers_nearby(30.2672, -97.7431, 25)`),
    );
    expect(result.rows.length).toBeGreaterThan(0);
    const row = result.rows.find((r) => r.trainer_id === trainerA);
    expect(row).toBeDefined();
    const columns = Object.keys(row!);
    expect(columns).not.toContain("exact_location");
    expect(columns).not.toContain("exact_address");
    expect(JSON.stringify(row)).not.toContain("Secret Home");
  });
});

describe("privilege escalation resistance", () => {
  it("users cannot grant themselves roles", async () => {
    await expect(
      db.as(clientA, (q) =>
        q(`insert into user_roles (user_id, role) values ($1, 'admin')`, [clientA]),
      ),
    ).rejects.toThrow();
  });

  it("trainers cannot self-approve their application", async () => {
    const pendingTrainer = await createUser(db, "pending-trainer");
    await db.admin(`insert into public.user_roles (user_id, role) values ($1, 'trainer')`, [
      pendingTrainer,
    ]);
    await db.admin(
      `insert into public.trainer_profiles (user_id, slug, application_status)
       values ($1, $2, 'submitted')`,
      [pendingTrainer, `pt-${pendingTrainer.slice(0, 8)}`],
    );
    await expect(
      db.as(pendingTrainer, (q) =>
        q(`update trainer_profiles set application_status = 'approved' where user_id = $1`, [
          pendingTrainer,
        ]),
      ),
    ).rejects.toThrow(/not permitted/);
  });

  it("anon can read only public approved trainer profiles", async () => {
    const hidden = await createUser(db, "hidden-trainer");
    await makeTrainer(db, hidden, { isPublic: false });
    const rows = await db.asAnon((q) => q(`select user_id from trainer_profiles`));
    const ids = rows.rows.map((r) => r.user_id);
    expect(ids).toContain(trainerA);
    expect(ids).not.toContain(hidden);
  });
});

describe("trainer application lifecycle (owner path used by /trainer/apply)", () => {
  it("owner can draft, submit once, and not edit or resubmit afterwards", async () => {
    const applicant = await createUser(db, "applicant");
    const slug = `apply-${applicant.slice(0, 8)}`;

    await db.asCommitted(applicant, (q) =>
      q(
        `insert into trainer_profiles (user_id, slug, headline, about)
         values ($1, $2, 'A headline long enough', 'About text')`,
        [applicant, slug],
      ),
    );

    // draft -> submitted is the only transition the owner may make;
    // the trigger stamps application_submitted_at.
    await db.asCommitted(applicant, (q) =>
      q(
        `update trainer_profiles set application_status = 'submitted'
         where user_id = $1 and application_status = 'draft'`,
        [applicant],
      ),
    );
    const submitted = await db.admin(
      `select application_status, application_submitted_at
       from trainer_profiles where user_id = $1`,
      [applicant],
    );
    expect(submitted.rows[0].application_status).toBe("submitted");
    expect(submitted.rows[0].application_submitted_at).not.toBeNull();

    // No going back to draft, no self-approval from submitted.
    await expect(
      db.as(applicant, (q) =>
        q(`update trainer_profiles set application_status = 'draft' where user_id = $1`, [
          applicant,
        ]),
      ),
    ).rejects.toThrow(/not permitted/);

    // Another user cannot create a trainer profile in the applicant's name.
    const impostor = await createUser(db, "impostor");
    await expect(
      db.as(impostor, (q) =>
        q(`insert into trainer_profiles (user_id, slug) values ($1, $2)`, [applicant, `${slug}-i`]),
      ),
    ).rejects.toThrow();
  });
});

describe("rate_limit_buckets is service-only", () => {
  it("denies both anon and authenticated roles entirely", async () => {
    await db.admin(
      `insert into rate_limit_buckets (key, tokens) values ('rls-test-bucket', 5)
       on conflict (key) do nothing`,
    );
    await expect(db.asAnon((q) => q(`select * from rate_limit_buckets`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.as(clientA, (q) => q(`select * from rate_limit_buckets`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.as(clientA, (q) =>
        q(`insert into rate_limit_buckets (key, tokens) values ('attacker', 999999)`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
