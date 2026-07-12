import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db, createUser, makeTrainer } from "./helpers.js";

const db = new Db();

// Austin, TX as the search origin.
const ORIGIN = { lat: 30.2672, lng: -97.7431 };

async function addTrainerAt(
  name: string,
  lat: number,
  lng: number,
  label: string,
): Promise<string> {
  const id = await createUser(db, name);
  await makeTrainer(db, id);
  await db.admin(
    `insert into public.trainer_service_locations
       (trainer_id, city_name, country_code, public_point, service_area_label, is_primary)
     values ($1, $2, 'US', st_setsrid(st_makepoint($3, $4), 4326)::geography, $5, true)`,
    [id, label, lng, lat, label],
  );
  return id;
}

let nearTrainer: string;
let midTrainer: string;
let farTrainer: string;

beforeAll(async () => {
  nearTrainer = await addTrainerAt("near", 30.27, -97.75, "Central Austin"); // ~1 km
  midTrainer = await addTrainerAt("mid", 30.51, -97.68, "Round Rock"); // ~28 km
  farTrainer = await addTrainerAt("far", 29.4241, -98.4936, "San Antonio"); // ~118 km
});

afterAll(async () => {
  await db.close();
});

describe("critical test 15: geographic search caps and pagination", () => {
  it("finds trainers within the requested radius, ordered by distance", async () => {
    const res = await db.asAnon((q) =>
      q(`select trainer_id, distance_m from app.search_trainers_nearby($1, $2, 30)`, [
        ORIGIN.lat,
        ORIGIN.lng,
      ]),
    );
    const ids = res.rows.map((r) => r.trainer_id);
    expect(ids).toContain(nearTrainer);
    expect(ids).toContain(midTrainer);
    expect(ids).not.toContain(farTrainer);
    const distances = res.rows.map((r) => Number(r.distance_m));
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it("clamps an oversized radius to 160 km server-side", async () => {
    const res = await db.asAnon((q) =>
      q(`select trainer_id, distance_m from app.search_trainers_nearby($1, $2, 99999)`, [
        ORIGIN.lat,
        ORIGIN.lng,
      ]),
    );
    for (const row of res.rows) {
      expect(Number(row.distance_m)).toBeLessThanOrEqual(160_000);
    }
    // San Antonio (~118 km) is inside the cap; nothing farther may appear.
    expect(res.rows.map((r) => r.trainer_id)).toContain(farTrainer);
  });

  it("clamps the page size to 50", async () => {
    const res = await db.asAnon((q) =>
      q(`select * from app.search_trainers_nearby($1, $2, 160, null, null, 100000)`, [
        ORIGIN.lat,
        ORIGIN.lng,
      ]),
    );
    expect(res.rows.length).toBeLessThanOrEqual(50);
  });

  it("supports stable keyset pagination", async () => {
    const page1 = await db.asAnon((q) =>
      q(`select trainer_id, distance_m from app.search_trainers_nearby($1, $2, 160, null, null, 2)`, [
        ORIGIN.lat,
        ORIGIN.lng,
      ]),
    );
    expect(page1.rows.length).toBe(2);
    const last = page1.rows.at(-1)!;
    const page2 = await db.asAnon((q) =>
      q(
        `select trainer_id from app.search_trainers_nearby($1, $2, 160, null, null, 2, $3, $4)`,
        [ORIGIN.lat, ORIGIN.lng, last.distance_m, last.trainer_id],
      ),
    );
    const ids1 = page1.rows.map((r) => r.trainer_id);
    for (const row of page2.rows) {
      expect(ids1).not.toContain(row.trainer_id);
    }
  });

  it("uses the GIST index for radius filtering", async () => {
    const plan = await db.admin(
      `explain (format json)
       select * from public.trainer_service_locations
       where st_dwithin(public_point, st_setsrid(st_makepoint($1, $2), 4326)::geography, 40000)`,
      [ORIGIN.lng, ORIGIN.lat],
    );
    const planText = JSON.stringify(plan.rows[0]);
    expect(planText).toMatch(/trainer_service_locations_public_point_gist|Index Scan/);
  });
});

describe("online search", () => {
  it("returns hybrid/online trainers with ranking and respects limits", async () => {
    const res = await db.asAnon((q) =>
      q(`select trainer_id, rank from app.search_trainers_online(null, null, null, null, 10)`),
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.length).toBeLessThanOrEqual(10);
    const ranks = res.rows.map((r) => Number(r.rank));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it("does not return unapproved or non-public trainers", async () => {
    const hiddenId = await createUser(db, "hidden-search");
    await db.admin(`insert into public.user_roles (user_id, role) values ($1, 'trainer')`, [
      hiddenId,
    ]);
    await db.admin(
      `insert into public.trainer_profiles (user_id, slug, application_status, is_public)
       values ($1, $2, 'submitted', false)`,
      [hiddenId, `hs-${hiddenId.slice(0, 8)}`],
    );
    const res = await db.asAnon((q) =>
      q(`select trainer_id from app.search_trainers_online(null, null, null, null, 50)`),
    );
    expect(res.rows.map((r) => r.trainer_id)).not.toContain(hiddenId);
  });
});
