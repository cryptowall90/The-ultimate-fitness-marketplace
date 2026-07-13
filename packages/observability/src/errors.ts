/**
 * Error-reporting provider interface (Sentry behind an adapter so tests and
 * low-cost deployments can use a no-op).
 */
export interface ErrorReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string, context?: Record<string, unknown>): void;
}

export class NoopErrorReporter implements ErrorReporter {
  captureException(): void {}
  captureMessage(): void {}
}
