import { randomBytes } from "node:crypto";

/**
 * Upload validation. MIME type is determined from file signatures (magic
 * bytes), never from the extension or client-declared content type. SVG is
 * rejected entirely (script-injection surface).
 */

export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export const ALLOWED_DOCUMENT_MIME = ["application/pdf"] as const;
export type AllowedMime = (typeof ALLOWED_IMAGE_MIME)[number] | (typeof ALLOWED_DOCUMENT_MIME)[number];

export const MAX_UPLOAD_BYTES = 1_048_576; // 1 MB post-compression default
export const MAX_DOCUMENT_BYTES = 10_485_760; // 10 MB for PDF credentials
export const MAX_DIMENSION = 8192; // reject image bombs by dimension
export const MAX_PIXELS = 40_000_000; // and by total pixel count

export interface ImageVariantSpec {
  name: string;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  targetBytes: [min: number, max: number];
}

export const IMAGE_VARIANTS: readonly ImageVariantSpec[] = [
  { name: "avatar", maxWidth: 64, maxHeight: 64, quality: 80, targetBytes: [10_000, 150_000] },
  { name: "thumbnail", maxWidth: 160, maxHeight: 160, quality: 80, targetBytes: [20_000, 200_000] },
  { name: "card", maxWidth: 480, maxHeight: 480, quality: 78, targetBytes: [150_000, 350_000] },
  { name: "detail", maxWidth: 1080, maxHeight: 1080, quality: 78, targetBytes: [200_000, 500_000] },
  { name: "progress", maxWidth: 1440, maxHeight: 1440, quality: 80, targetBytes: [250_000, 600_000] },
];

/** Detect real content type from magic bytes. Returns null when unrecognized. */
export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // AVIF: ISO BMFF "ftyp" + brand avif/avis
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  // PDF: "%PDF"
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  return null;
}

export interface UploadValidationInput {
  bytes: Uint8Array;
  declaredMime: string;
  kind: "image" | "document";
  width?: number;
  height?: number;
}

export type UploadValidationResult =
  | { ok: true; mime: AllowedMime }
  | { ok: false; reason: string };

export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  const sniffed = sniffMime(input.bytes);
  if (!sniffed) {
    return { ok: false, reason: "unrecognized or unsupported file signature" };
  }
  // Polyglot/MIME-confusion protection: declared type must match the signature.
  if (sniffed !== input.declaredMime) {
    return { ok: false, reason: "declared content type does not match file signature" };
  }
  if (input.kind === "image") {
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(sniffed)) {
      return { ok: false, reason: "not an allowed image type" };
    }
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      return { ok: false, reason: "image exceeds maximum upload size" };
    }
    if (input.width !== undefined && input.height !== undefined) {
      if (input.width > MAX_DIMENSION || input.height > MAX_DIMENSION) {
        return { ok: false, reason: "image dimensions too large" };
      }
      if (input.width * input.height > MAX_PIXELS) {
        return { ok: false, reason: "image pixel count too large" };
      }
      if (input.width < 1 || input.height < 1) {
        return { ok: false, reason: "invalid image dimensions" };
      }
    }
  } else {
    if (!(ALLOWED_DOCUMENT_MIME as readonly string[]).includes(sniffed)) {
      return { ok: false, reason: "not an allowed document type" };
    }
    if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return { ok: false, reason: "document exceeds maximum upload size" };
    }
  }
  return { ok: true, mime: sniffed };
}

/** Random object keys — user filenames are display metadata only, never paths. */
export function generateObjectKey(prefix: "public" | "progress" | "documents"): string {
  const token = randomBytes(24).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "");
  const shard = token.slice(0, 2);
  return `${prefix}/${shard}/${token}`;
}
