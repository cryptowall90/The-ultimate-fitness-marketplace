import type {
  MediaStorageProvider,
  SignedDownloadUrl,
  SignedUploadAuthorization,
} from "./provider.js";

/**
 * Supabase Storage implementation of MediaStorageProvider using the Storage
 * REST API directly (no extra SDK dependency). Runs ONLY in privileged server
 * contexts: it authenticates with the service-role key, which must never reach
 * a client bundle. The base URL is fixed configuration — outbound requests can
 * only go to the configured Supabase project (no user-controlled URLs → no
 * SSRF surface).
 */
export class SupabaseStorageProvider implements MediaStorageProvider {
  readonly name = "supabase_storage" as const;
  private readonly baseUrl: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = supabaseUrl.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra,
    };
  }

  private objectPath(bucket: string, objectKey: string): string {
    // objectKey is server-generated ([a-z0-9/_-]); encode each segment anyway.
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
    return `${encodeURIComponent(bucket)}/${encodedKey}`;
  }

  async createSignedUpload(req: {
    bucket: string;
    objectKey: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedUploadAuthorization> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/upload/sign/${this.objectPath(req.bucket, req.objectKey)}`,
      { method: "POST", headers: this.headers({ "content-type": "application/json" }) },
    );
    if (!res.ok) {
      throw new Error(`storage signed-upload request failed (${res.status})`);
    }
    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new Error("storage did not return a signed upload URL");
    return {
      url: `${this.baseUrl}/storage/v1${body.url}`,
      method: "PUT",
      headers: { "content-type": req.contentType },
      objectKey: req.objectKey,
      // Supabase signed upload tokens are valid for 2 h server-side; we surface
      // the shorter application expiry so clients treat it as one-shot.
      expiresAt: new Date(Date.now() + req.expiresInSeconds * 1000),
      maxBytes: req.maxBytes,
    };
  }

  async createSignedDownload(req: {
    bucket: string;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<SignedDownloadUrl> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/sign/${this.objectPath(req.bucket, req.objectKey)}`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ expiresIn: req.expiresInSeconds }),
      },
    );
    if (!res.ok) {
      throw new Error(`storage signed-download request failed (${res.status})`);
    }
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL) throw new Error("storage did not return a signed download URL");
    return {
      url: `${this.baseUrl}/storage/v1${body.signedURL}`,
      expiresAt: new Date(Date.now() + req.expiresInSeconds * 1000),
    };
  }

  async getObjectBytes(req: { bucket: string; objectKey: string }): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${this.objectPath(req.bucket, req.objectKey)}`,
      { method: "GET", headers: this.headers() },
    );
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`storage object read failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteObject(req: { bucket: string; objectKey: string }): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${this.objectPath(req.bucket, req.objectKey)}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`storage object delete failed (${res.status})`);
    }
  }
}
