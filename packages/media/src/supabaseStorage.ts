import type {
  MediaStorageProvider,
  SignedDownloadUrl,
  SignedUploadAuthorization,
} from "./provider.js";

/**
 * Supabase Storage implementation of MediaStorageProvider, using the Storage
 * REST API with the service-role key. Server-only — the key must never reach
 * a client bundle.
 */
export class SupabaseStorageProvider implements MediaStorageProvider {
  readonly name = "supabase_storage" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
  ) {
    if (!/^https:\/\//.test(baseUrl) && !baseUrl.startsWith("http://127.0.0.1")) {
      throw new Error("supabase storage base url must be https");
    }
    if (serviceRoleKey.length < 20) throw new Error("service role key missing or too short");
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/storage/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.serviceRoleKey}`,
        apikey: this.serviceRoleKey,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      // No provider response bodies in errors — they can echo internals.
      throw new Error(`storage request failed: ${res.status}`);
    }
    return res;
  }

  async createSignedUpload(req: {
    bucket: string;
    objectKey: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedUploadAuthorization> {
    const res = await this.request(`/object/upload/sign/${req.bucket}/${req.objectKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { url: string };
    return {
      // Supabase returns a bucket-relative signed path.
      url: `${this.baseUrl}/storage/v1${body.url}`,
      method: "PUT",
      headers: { "content-type": req.contentType },
      objectKey: req.objectKey,
      expiresAt: new Date(Date.now() + req.expiresInSeconds * 1000),
      maxBytes: req.maxBytes,
    };
  }

  async createSignedDownload(req: {
    bucket: string;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<SignedDownloadUrl> {
    const res = await this.request(`/object/sign/${req.bucket}/${req.objectKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: req.expiresInSeconds }),
    });
    const body = (await res.json()) as { signedURL: string };
    return {
      url: `${this.baseUrl}/storage/v1${body.signedURL}`,
      expiresAt: new Date(Date.now() + req.expiresInSeconds * 1000),
    };
  }

  async getObject(req: {
    bucket: string;
    objectKey: string;
    maxBytes: number;
  }): Promise<Uint8Array> {
    const res = await this.request(`/object/${req.bucket}/${req.objectKey}`, { method: "GET" });
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > req.maxBytes) throw new Error("object exceeds maximum size");
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > req.maxBytes) throw new Error("object exceeds maximum size");
    return buffer;
  }

  async deleteObject(req: { bucket: string; objectKey: string }): Promise<void> {
    await this.request(`/object/${req.bucket}/${req.objectKey}`, { method: "DELETE" });
  }
}
