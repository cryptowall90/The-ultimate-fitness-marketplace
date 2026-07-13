import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createUser, signAccessToken, type TestApp, json } from "./helpers.js";

let t: TestApp;
let user: string;

beforeAll(async () => {
  t = createTestApp();
  user = await createUser(t.pool, "uploader");
});

afterAll(async () => {
  await t.close();
});

// Minimal valid file signatures (magic bytes + padding).
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(16).fill(0)]);
const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(16).fill(0),
]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(16).fill(0)]);

async function requestUpload(body: object, userId = user): Promise<Response> {
  return t.app.request("/v1/media/uploads", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await signAccessToken(userId)}`,
    },
  });
}

async function complete(mediaId: string, userId = user): Promise<Response> {
  return t.app.request(`/v1/media/uploads/${mediaId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${await signAccessToken(userId)}` },
  });
}

/** Simulates the client's direct PUT to storage. */
async function uploadBytes(mediaId: string, bytes: Uint8Array): Promise<void> {
  const row = await t.pool.query(`select bucket, object_key from media_objects where id = $1`, [
    mediaId,
  ]);
  t.mediaStorage.put(row.rows[0].bucket, row.rows[0].object_key, bytes);
}

describe("media signed-upload flow", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await t.app.request("/v1/media/uploads", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects disallowed types and oversized declarations", async () => {
    const svg = await requestUpload({
      kind: "avatar",
      contentType: "image/svg+xml",
      byteSize: 1000,
    });
    expect(svg.status).toBe(400);
    expect((await json(svg)).error.code).toBe("type_not_allowed");

    const big = await requestUpload({
      kind: "avatar",
      contentType: "image/jpeg",
      byteSize: 2_000_000, // over the 1 MB image cap
    });
    expect(big.status).toBe(400);
    expect((await json(big)).error.code).toBe("too_large");
  });

  it("issues a signed upload with a random key and publishes a verified image", async () => {
    const res = await requestUpload({
      kind: "avatar",
      contentType: "image/jpeg",
      byteSize: JPEG_BYTES.byteLength,
      originalFilename: "../../etc/passwd.jpg",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.upload.url).toContain("https://storage.fake.test/upload/public-media/");
    expect(body.upload.method).toBe("PUT");

    const row = await t.pool.query(
      `select status, object_key, visibility, original_filename from media_objects where id = $1`,
      [body.mediaId],
    );
    expect(row.rows[0].status).toBe("pending_upload");
    expect(row.rows[0].visibility).toBe("public_profile");
    // Random server-generated key — never derived from the user's filename.
    expect(row.rows[0].object_key).toMatch(/^public\/[a-z0-9]{2}\/[a-z0-9]+$/);
    expect(row.rows[0].object_key).not.toContain("passwd");

    await uploadBytes(body.mediaId, JPEG_BYTES);
    const done = await complete(body.mediaId);
    expect(done.status).toBe(200);
    expect((await json(done)).status).toBe("published");

    const after = await t.pool.query(
      `select status, byte_size, published_at from media_objects where id = $1`,
      [body.mediaId],
    );
    expect(after.rows[0].status).toBe("published");
    expect(after.rows[0].byte_size).toBe(JPEG_BYTES.byteLength);
    expect(after.rows[0].published_at).not.toBeNull();
  });

  it("rejects a polyglot upload: declared jpeg, actual png bytes", async () => {
    const res = await requestUpload({
      kind: "avatar",
      contentType: "image/jpeg",
      byteSize: PNG_BYTES.byteLength,
    });
    const { mediaId } = await json(res);
    await uploadBytes(mediaId, PNG_BYTES);

    const done = await complete(mediaId);
    expect(done.status).toBe(422);
    expect((await json(done)).error.code).toBe("verification_failed");

    const row = await t.pool.query(
      `select status, quarantine_reason, bucket, object_key from media_objects where id = $1`,
      [mediaId],
    );
    expect(row.rows[0].status).toBe("rejected");
    expect(row.rows[0].quarantine_reason).toContain("does not match");
    // The stored object was deleted, not left lying around.
    expect(t.mediaStorage.deleted).toContain(`${row.rows[0].bucket}/${row.rows[0].object_key}`);
  });

  it("quarantines verified documents instead of publishing them", async () => {
    const res = await requestUpload({
      kind: "credential_document",
      contentType: "application/pdf",
      byteSize: PDF_BYTES.byteLength,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.upload.url).toContain("/private-media/");

    await uploadBytes(body.mediaId, PDF_BYTES);
    const done = await complete(body.mediaId);
    expect(done.status).toBe(200);
    expect((await json(done)).status).toBe("quarantined");
  });

  it("only the owner can complete an upload", async () => {
    const res = await requestUpload({
      kind: "avatar",
      contentType: "image/jpeg",
      byteSize: JPEG_BYTES.byteLength,
    });
    const { mediaId } = await json(res);
    await uploadBytes(mediaId, JPEG_BYTES);

    const other = await createUser(t.pool, "upload-thief");
    const stolen = await complete(mediaId, other);
    expect(stolen.status).toBe(404);

    const row = await t.pool.query(`select status from media_objects where id = $1`, [mediaId]);
    expect(row.rows[0].status).toBe("pending_upload");
  });

  it("enforces the per-user storage quota", async () => {
    const hoarder = await createUser(t.pool, "hoarder");
    // Existing published media already at the quota edge.
    await t.pool.query(
      `insert into media_objects
         (owner_id, provider, bucket, object_key, visibility, status, mime_type, byte_size)
       values ($1, 'supabase_storage', 'public-media', 'public/aa/existingquotafiller',
               'public_profile', 'published', 'image/jpeg', 10000000)`,
      [hoarder],
    );
    await t.pool.query(
      `insert into system_settings (key, value, description)
       values ('uploads.per_user_quota_bytes', '10000500', 'test quota')
       on conflict (key) do update set value = excluded.value`,
    );
    try {
      const res = await requestUpload(
        { kind: "avatar", contentType: "image/jpeg", byteSize: 1000 },
        hoarder,
      );
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("quota_exceeded");

      const small = await requestUpload(
        { kind: "avatar", contentType: "image/jpeg", byteSize: 400 },
        hoarder,
      );
      expect(small.status).toBe(200);
    } finally {
      await t.pool.query(
        `update system_settings set value = '524288000'
         where key = 'uploads.per_user_quota_bytes'`,
      );
    }
  });
});
