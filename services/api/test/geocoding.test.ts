import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@fitmarket/observability";
import { ChainGeocoder, NominatimGeocoder, StaticCityGeocoder } from "../src/services/geocoding.js";

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const log = createLogger({ service: "geo-test", destination: sink });

const nominatimHit = JSON.stringify([
  { lat: "30.2672", lon: "-97.7431", display_name: "Austin, Travis County, Texas, USA" },
]);

describe("StaticCityGeocoder", () => {
  it("resolves launch cities case-insensitively, US only", async () => {
    const geo = new StaticCityGeocoder();
    expect(await geo.resolveCity({ city: "  AUSTIN ", countryCode: "US" })).toMatchObject({
      lat: 30.2672,
      lng: -97.7431,
    });
    expect(await geo.resolveCity({ city: "austin", countryCode: "DE" })).toBeNull();
    expect(await geo.resolveCity({ city: "springfield", countryCode: "US" })).toBeNull();
  });
});

describe("NominatimGeocoder", () => {
  it("requires https and encodes user input as query parameters only", async () => {
    expect(() => new NominatimGeocoder("http://geo.example.com", log)).toThrow(/https/);

    const fetchMock = vi.fn<typeof fetch>(async () => new Response(nominatimHit, { status: 200 }));
    const geo = new NominatimGeocoder("https://geo.example.com", log, fetchMock);
    await geo.resolveCity({
      city: "austin?admin=1#frag/../etc",
      region: "tex&as",
      countryCode: "US",
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.host).toBe("geo.example.com");
    expect(url.pathname).toBe("/search");
    // Hostile characters stay inside encoded query parameters.
    expect(url.searchParams.get("city")).toBe("austin?admin=1#frag/../etc");
    expect(url.searchParams.get("state")).toBe("tex&as");
    // Redirects are refused; requests carry a timeout signal.
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("parses valid responses and caches by normalized city", async () => {
    const fetchMock = vi.fn(async () => new Response(nominatimHit, { status: 200 }));
    const geo = new NominatimGeocoder("https://geo.example.com", log, fetchMock);

    const first = await geo.resolveCity({ city: "Austin", countryCode: "US" });
    expect(first).toEqual({ lat: 30.2672, lng: -97.7431, canonicalName: "Austin, Travis County" });

    const second = await geo.resolveCity({ city: "  austin ", countryCode: "us" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit
  });

  it("returns null on malformed responses and transport errors", async () => {
    const badShape = vi.fn(async () => new Response(`{"weird": true}`, { status: 200 }));
    const geo1 = new NominatimGeocoder("https://geo.example.com", log, badShape);
    expect(await geo1.resolveCity({ city: "austin", countryCode: "US" })).toBeNull();

    const boom = vi.fn(async () => {
      throw new Error("network down");
    });
    const geo2 = new NominatimGeocoder("https://geo.example.com", log, boom);
    expect(await geo2.resolveCity({ city: "austin", countryCode: "US" })).toBeNull();
    // Transport errors are not cached — a retry re-fetches.
    expect(await geo2.resolveCity({ city: "austin", countryCode: "US" })).toBeNull();
    expect(boom).toHaveBeenCalledTimes(2);
  });
});

describe("ChainGeocoder", () => {
  it("prefers the static table and falls through on miss", async () => {
    const fetchMock = vi.fn(async () => new Response(nominatimHit, { status: 200 }));
    const chain = new ChainGeocoder([
      new StaticCityGeocoder(),
      new NominatimGeocoder("https://geo.example.com", log, fetchMock),
    ]);

    await chain.resolveCity({ city: "austin", countryCode: "US" });
    expect(fetchMock).not.toHaveBeenCalled(); // static hit, no egress

    await chain.resolveCity({ city: "smallville", countryCode: "US" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // fell through
  });
});
