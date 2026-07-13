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
let fixture: TrainerFixture;
let regularUser: string;

beforeAll(async () => {
  t = createTestApp();
  fixture = await createSellableTrainer(t.pool);
  regularUser = await createUser(t.pool, "loc-regular");
});

afterAll(async () => {
  await t.close();
});

async function postLocation(body: object, userId = fixture.trainerId): Promise<Response> {
  return t.app.request("/v1/trainer/locations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await signAccessToken(userId)}`,
    },
  });
}

const AUSTIN = { cityName: "Austin", countryCode: "US", serviceRadiusKm: 25, isPrimary: true };

describe("trainer service locations", () => {
  it("rejects unauthenticated requests and non-trainers", async () => {
    const anon = await t.app.request("/v1/trainer/locations", {
      method: "POST",
      body: JSON.stringify(AUSTIN),
      headers: { "content-type": "application/json" },
    });
    expect(anon.status).toBe(401);

    const notTrainer = await postLocation(AUSTIN, regularUser);
    expect(notTrainer.status).toBe(403);
  });

  it("creates a location with a server-geocoded public point", async () => {
    const res = await postLocation({ ...AUSTIN, exactAddress: "123 Private St, Austin" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.serviceAreaLabel).toContain("Austin");

    const row = await t.pool.query(
      `select city_name, service_area_label, is_primary, exact_address,
              st_y(public_point::geometry) as lat, st_x(public_point::geometry) as lng
       from trainer_service_locations where id = $1`,
      [body.locationId],
    );
    // Coordinates come from the server's geocoder, not the request body.
    expect(Number(row.rows[0].lat)).toBeCloseTo(30.2672, 3);
    expect(Number(row.rows[0].lng)).toBeCloseTo(-97.7431, 3);
    expect(row.rows[0].is_primary).toBe(true);
    expect(row.rows[0].exact_address).toBe("123 Private St, Austin");

    // The trainer is now discoverable via the capped nearby search (which
    // only lists in-person/hybrid trainers).
    await t.pool.query(`update trainer_profiles set service_mode = 'hybrid' where user_id = $1`, [
      fixture.trainerId,
    ]);
    const found = await t.pool.query(
      `select trainer_id from public.search_trainers_nearby(30.27, -97.74, 25, null, null, 20)`,
    );
    expect(found.rows.map((r) => r.trainer_id)).toContain(fixture.trainerId);
  });

  it("client-supplied coordinates are rejected by the strict schema", async () => {
    const res = await postLocation({ ...AUSTIN, lat: 0.0001, lng: 0.0001 });
    expect(res.status).toBe(400);
  });

  it("a new primary location demotes the previous one", async () => {
    const second = await postLocation({
      cityName: "Denver",
      countryCode: "US",
      serviceRadiusKm: 40,
      isPrimary: true,
    });
    expect(second.status).toBe(200);

    const rows = await t.pool.query(
      `select city_name, is_primary from trainer_service_locations
       where trainer_id = $1 order by created_at`,
      [fixture.trainerId],
    );
    expect(rows.rows.filter((r) => r.is_primary)).toHaveLength(1);
    expect(rows.rows.find((r) => r.is_primary)?.city_name).toBe("Denver");
  });

  it("returns 422 for unknown cities", async () => {
    const res = await postLocation({
      cityName: "Atlantis",
      countryCode: "US",
      serviceRadiusKm: 10,
      isPrimary: false,
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("city_not_found");
  });

  it("deletes only the caller's own locations", async () => {
    const created = await json(
      await postLocation({
        cityName: "Miami",
        countryCode: "US",
        serviceRadiusKm: 15,
        isPrimary: false,
      }),
    );

    const thief = await t.app.request(`/v1/trainer/locations/${created.locationId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${await signAccessToken(regularUser)}` },
    });
    expect(thief.status).toBe(404);

    const own = await t.app.request(`/v1/trainer/locations/${created.locationId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${await signAccessToken(fixture.trainerId)}` },
    });
    expect(own.status).toBe(200);

    const gone = await t.pool.query(`select 1 from trainer_service_locations where id = $1`, [
      created.locationId,
    ]);
    expect(gone.rowCount).toBe(0);
  });
});
