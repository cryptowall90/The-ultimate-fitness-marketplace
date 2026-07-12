import { describe, expect, it } from "vitest";
import { generateObjectKey, sniffMime, validateUpload, MAX_UPLOAD_BYTES } from "../src/validation.js";

function bytes(...values: number[]): Uint8Array {
  const arr = new Uint8Array(Math.max(16, values.length));
  arr.set(values);
  return arr;
}

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

describe("sniffMime", () => {
  it("detects supported formats by signature", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(PDF)).toBe("application/pdf");
  });

  it("does not recognize SVG or random bytes", () => {
    expect(sniffMime(SVG)).toBeNull();
    expect(sniffMime(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBeNull();
  });
});

describe("validateUpload", () => {
  it("accepts a genuine jpeg", () => {
    expect(validateUpload({ bytes: JPEG, declaredMime: "image/jpeg", kind: "image" })).toEqual({
      ok: true,
      mime: "image/jpeg",
    });
  });

  it("rejects SVG uploads entirely", () => {
    const result = validateUpload({ bytes: SVG, declaredMime: "image/svg+xml", kind: "image" });
    expect(result.ok).toBe(false);
  });

  it("rejects polyglot/MIME-confusion (png bytes declared as jpeg)", () => {
    const result = validateUpload({ bytes: PNG, declaredMime: "image/jpeg", kind: "image" });
    expect(result.ok).toBe(false);
  });

  it("rejects a PDF smuggled as an image", () => {
    const result = validateUpload({ bytes: PDF, declaredMime: "image/png", kind: "image" });
    expect(result.ok).toBe(false);
  });

  it("rejects oversized uploads", () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(validateUpload({ bytes: big, declaredMime: "image/jpeg", kind: "image" }).ok).toBe(false);
  });

  it("rejects image bombs by dimensions", () => {
    expect(
      validateUpload({
        bytes: JPEG,
        declaredMime: "image/jpeg",
        kind: "image",
        width: 30000,
        height: 30000,
      }).ok,
    ).toBe(false);
  });
});

describe("generateObjectKey", () => {
  it("generates random, prefix-scoped, path-safe keys", () => {
    const a = generateObjectKey("progress");
    const b = generateObjectKey("progress");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^progress\/[a-z0-9]{2}\/[a-z0-9]+$/);
    expect(a).not.toContain("..");
  });
});
