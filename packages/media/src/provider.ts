/**
 * Media provider abstraction so storage can move between Supabase Storage,
 * Cloudflare Images and R2 without touching call sites.
 */

export interface SignedUploadAuthorization {
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  objectKey: string;
  expiresAt: Date;
  maxBytes: number;
}

export interface SignedDownloadUrl {
  url: string;
  expiresAt: Date;
}

export interface MediaStorageProvider {
  readonly name: "supabase_storage" | "cloudflare_images" | "r2";
  /** One-time, short-lived, size-capped upload authorization. */
  createSignedUpload(req: {
    bucket: string;
    objectKey: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedUploadAuthorization>;
  /** Short-lived signed download for PRIVATE media. Authorize before calling. */
  createSignedDownload(req: {
    bucket: string;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<SignedDownloadUrl>;
  /**
   * Reads the raw object back for server-side verification (magic-byte sniff,
   * size check, hashing) after the client PUT. Returns null when the object
   * does not exist (upload never happened or already cleaned up).
   */
  getObjectBytes(req: { bucket: string; objectKey: string }): Promise<Uint8Array | null>;
  deleteObject(req: { bucket: string; objectKey: string }): Promise<void>;
}
