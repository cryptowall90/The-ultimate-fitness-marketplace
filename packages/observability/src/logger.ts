import { randomUUID } from "node:crypto";
import { pino, stdTimeFunctions, type Logger } from "pino";

/**
 * Structured JSON logger with mandatory redaction. Message bodies, tokens,
 * credentials, payment secrets and sensitive fitness data must never reach
 * log output — redaction paths below are the enforced safety net; call sites
 * must still not pass such values.
 */

const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "apiKey",
  "*.apiKey",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "cookie",
  "*.cookie",
  "setCookie",
  "body",
  "*.body",
  "messageBody",
  "*.messageBody",
  "email",
  "*.email",
  "exactAddress",
  "*.exactAddress",
  "cardNumber",
  "*.cardNumber",
  "clientSecret",
  "*.clientSecret",
  "stripeSignature",
  "*.stripeSignature",
];

export interface LoggerOptions {
  service: string;
  level?: string;
  destination?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: { service: options.service },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      timestamp: stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
    },
    options.destination,
  );
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Child logger carrying the request correlation id. */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
