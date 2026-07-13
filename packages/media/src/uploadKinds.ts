import {
  ALLOWED_DOCUMENT_MIME,
  ALLOWED_IMAGE_MIME,
  MAX_DOCUMENT_BYTES,
  MAX_UPLOAD_BYTES,
} from "./validation.js";

/**
 * Upload kinds the platform accepts, mapping user intent to storage policy.
 * Everything here is server-enforced: visibility, bucket class, mime
 * allowlist, size cap, and the random object-key prefix.
 */
export type UploadKind = "avatar" | "credential_document";

export interface UploadKindPolicy {
  kind: "image" | "document";
  visibility: "public_profile" | "private_document";
  bucketClass: "public" | "private";
  keyPrefix: "public" | "documents";
  allowedMime: readonly string[];
  maxBytes: number;
  /** Documents wait in quarantine for the scan job; images publish on verify. */
  publishOnVerify: boolean;
}

export const UPLOAD_KINDS: Record<UploadKind, UploadKindPolicy> = {
  avatar: {
    kind: "image",
    visibility: "public_profile",
    bucketClass: "public",
    keyPrefix: "public",
    allowedMime: ALLOWED_IMAGE_MIME,
    maxBytes: MAX_UPLOAD_BYTES,
    publishOnVerify: true,
  },
  credential_document: {
    kind: "document",
    visibility: "private_document",
    bucketClass: "private",
    keyPrefix: "documents",
    allowedMime: ALLOWED_DOCUMENT_MIME,
    maxBytes: MAX_DOCUMENT_BYTES,
    publishOnVerify: false,
  },
};
