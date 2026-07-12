import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, newCorrelationId, withCorrelation } from "../src/logger.js";

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("redacting logger", () => {
  it("redacts tokens, passwords, cookies, message bodies and emails", () => {
    const { stream, lines } = capture();
    const log = createLogger({ service: "test", destination: stream });
    log.info(
      {
        password: "hunter22222",
        token: "eyJhbGciOi",
        user: { email: "a@b.com", accessToken: "secret-token" },
        messageBody: "private chat content",
        exactAddress: "1 Private Home Ln",
        amountCents: 3499,
      },
      "payment processed",
    );
    const [entry] = lines();
    const flat = JSON.stringify(entry);
    expect(flat).not.toContain("hunter22222");
    expect(flat).not.toContain("eyJhbGciOi");
    expect(flat).not.toContain("a@b.com");
    expect(flat).not.toContain("secret-token");
    expect(flat).not.toContain("private chat content");
    expect(flat).not.toContain("1 Private Home Ln");
    expect(entry).toMatchObject({ amountCents: 3499, msg: "payment processed" });
  });

  it("propagates correlation ids to child loggers", () => {
    const { stream, lines } = capture();
    const log = createLogger({ service: "test", destination: stream });
    const correlationId = newCorrelationId();
    withCorrelation(log, correlationId).info("hello");
    expect(lines()[0]).toMatchObject({ correlationId });
  });
});
