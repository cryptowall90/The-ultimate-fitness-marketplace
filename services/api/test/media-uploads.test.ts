import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createUser, json, signAccessToken, type TestApp } from "./helpers.js";

let t: TestApp;
let owner: string;
let other: string;

beforeAll(async () => {
  t = createTestApp();
  owner = await createUser(t.pool, "uploader");
  other = await createUser(t.pool, "other-user");
});

afterAll(async () => {
  await t.close();
});

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

async function requestUpload(token: string, payload: Record<string, unknown>): Promise<Response> {
  return t.app.request("/v1/media/uploads", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
}

describe("media signed uploads", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await t.app.request("/v1/media/uploads", {
      method: "POST",
      body: JSON.stringify({ kind: "avatar", declaredMime: "image/png", byteSize: 1000 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects unknown fields (strict schema)", async () => {
    const token = await signAccessToken(owner);
    const res = await requestUpload(token, {
      kind: "avatar",
      declaredMime: "image/png",
      byteSize: 1000,
      objectKey: "../../etc/passwd",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a PDF declared for an avatar upload", async () => {
    const token = await signAccessToken(owner);
    const res = await requestUpload(token, {
      kind: "avatar",
      declaredMime: "application/pdf",
      byteSize: 1000,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("unsupported_type");
  });

  it("rejects images above the avatar size cap", async () => {
    const token = await signAccessToken(owner);
    const res = await requestUpload(token, {
      kind: "avatar",
      declaredMime: "image/png",
      byteSize: 2_000_000,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("too_large");
  });

  it("issues a signed upload with a random server-generated key", async () => {
    const token = await signAccessToken(owner);
    const res = await requestUpload(token, {
      kind: "avatar",
      declaredMime: "image/png",
      byteSize: PNG_BYTES.byteLength,
      originalFilename: "my avatar.png",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mediaId).toBeDefined();
    expect(body.upload.url).toContain("https://storage.test/upload/");
    expect(body.upload.method).toBe("PUT");

    const row = await t.pool.query(
      `select owner_id, bucket, object_key, visibility, status, mime_type, original_filename
       from media_objects where id = $1`,
      [body.mediaId],
    );
    expect(row.rows[0].owner_id).toBe(owner);
    expect(row.rows[0].status).toBe("pending_upload");
    expect(row.rows[0].visibility).toBe("public_profile");
    // random key under the public prefix — never the user filename
    expect(row.rows[0].object_key).toMatch(/^public\/[a-z0-9]{2}\/[a-z0-9]+$/);
    expect(row.rows[0].original_filename).toBe("my avatar.png");
  });

  it("enforces the per-user storage quota", async () => {
    await t.pool.query(
      `update system_settings set value = '4000' where key = 'uploads.per_user_quota_bytes'`,
    );
    try {
      const quotaUser = await createUser(t.pool, "quota-user");
      const token = await signAccessToken(quotaUser);
      const first = await requestUpload(token, {
        kind: "avatar",
        declaredMime: "image/png",
        byteSize: 3000,
      });
      expect(first.status).toBe(200);
      const second = await requestUpload(token, {
        kind: "avatar",
        declaredMime: "image/png",
        byteSize: 3000,
      });
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe("quota_exceeded");
    } finally {
      await t.pool.query(
        `update system_settings set value = '524288000' where key = 'uploads.per_user_quota_bytes'`,
      );
    }
  });
});

describe("media upload finalize", () => {
  async function createPendingUpload(
    token: string,
    declaredMime = "image/png",
  ): Promise<{ mediaId: string; bucket: string; objectKey: string }> {
    const res = await requestUpload(token, {
      kind: "avatar",
      declaredMime,
      byteSize: PNG_BYTES.byteLength,
    });
    const body = await json(res);
    const row = await t.pool.query(`select bucket, object_key from media_objects where id = $1`, [
      body.mediaId,
    ]);
    return { mediaId: body.mediaId, bucket: row.rows[0].bucket, objectKey: row.rows[0].object_key };
  }

  it("quarantines a verified upload and records its hash", async () => {
    const token = await signAccessToken(owner);
    const upload = await createPendingUpload(token);
    t.media.put(upload.bucket, upload.objectKey, PNG_BYTES);

    const res = await t.app.request(`/v1/media/uploads/${upload.mediaId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("quarantined");

    const row = await t.pool.query(
      `select status, sha256, byte_size, uploaded_at from media_objects where id = $1`,
      [upload.mediaId],
    );
    expect(row.rows[0].status).toBe("quarantined");
    expect(row.rows[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.rows[0].byte_size).toBe(PNG_BYTES.byteLength);
    expect(row.rows[0].uploaded_at).not.toBeNull();
  });

  it("rejects polyglot/mismatched content and deletes the object", async () => {
    const token = await signAccessToken(owner);
    const upload = await createPendingUpload(token, "image/png");
    // Client declared PNG but actually uploaded a JPEG.
    t.media.put(upload.bucket, upload.objectKey, JPEG_BYTES);

    const res = await t.app.request(`/v1/media/uploads/${upload.mediaId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("rejected");

    const row = await t.pool.query(
      `select status, quarantine_reason from media_objects where id = $1`,
      [upload.mediaId],
    );
    expect(row.rows[0].status).toBe("rejected");
    expect(row.rows[0].quarantine_reason).toContain("does not match");
    expect(t.media.deleted).toContain(`${upload.bucket}/${upload.objectKey}`);
  });

  it("returns 409 when nothing was uploaded", async () => {
    const token = await signAccessToken(owner);
    const upload = await createPendingUpload(token);
    const res = await t.app.request(`/v1/media/uploads/${upload.mediaId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("not_uploaded");
  });

  it("never finalizes another user's upload", async () => {
    const ownerToken = await signAccessToken(owner);
    const upload = await createPendingUpload(ownerToken);
    t.media.put(upload.bucket, upload.objectKey, PNG_BYTES);

    const otherToken = await signAccessToken(other);
    const res = await t.app.request(`/v1/media/uploads/${upload.mediaId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(404);
  });
});
