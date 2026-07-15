import { describe, expect, it } from "vitest";
import { SupabaseStorageProvider } from "../src/supabaseStorage.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function providerWith(
  response: { status: number; body?: unknown },
  recorded: RecordedRequest[],
): SupabaseStorageProvider {
  const fetchStub = (async (input: unknown, init?: RequestInit) => {
    recorded.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
    });
  }) as typeof fetch;
  return new SupabaseStorageProvider("https://proj.supabase.co/", "service-key-test", fetchStub);
}

describe("SupabaseStorageProvider", () => {
  it("requests a signed upload and returns an absolute URL", async () => {
    const recorded: RecordedRequest[] = [];
    const provider = providerWith(
      { status: 200, body: { url: "/object/upload/sign/bucket/public/ab/key?token=t" } },
      recorded,
    );
    const result = await provider.createSignedUpload({
      bucket: "public-media",
      objectKey: "public/ab/somekey",
      contentType: "image/png",
      maxBytes: 1000,
      expiresInSeconds: 300,
    });
    expect(recorded[0]!.url).toBe(
      "https://proj.supabase.co/storage/v1/object/upload/sign/public-media/public/ab/somekey",
    );
    expect(recorded[0]!.method).toBe("POST");
    expect(recorded[0]!.headers.authorization).toBe("Bearer service-key-test");
    expect(result.url).toBe(
      "https://proj.supabase.co/storage/v1/object/upload/sign/bucket/public/ab/key?token=t",
    );
    expect(result.method).toBe("PUT");
    expect(result.headers["content-type"]).toBe("image/png");
  });

  it("throws when storage refuses to sign", async () => {
    const provider = providerWith({ status: 403 }, []);
    await expect(
      provider.createSignedUpload({
        bucket: "b",
        objectKey: "public/ab/key",
        contentType: "image/png",
        maxBytes: 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(/signed-upload request failed \(403\)/);
  });

  it("returns null for missing objects instead of throwing", async () => {
    const provider = providerWith({ status: 404 }, []);
    const bytes = await provider.getObjectBytes({ bucket: "b", objectKey: "public/ab/key" });
    expect(bytes).toBeNull();
  });
});
