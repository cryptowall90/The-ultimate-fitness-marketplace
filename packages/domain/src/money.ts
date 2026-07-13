import type { Money } from "@fitmarket/types";

/**
 * All monetary arithmetic uses integer minor units. Any operation that would
 * produce a non-integer or unsafe value throws instead of silently rounding.
 */

function assertIntCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer number of cents, got ${value}`);
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function money(amountCents: number, currency: string): Money {
  assertIntCents(amountCents, "amountCents");
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new TypeError(`invalid currency code: ${currency}`);
  }
  return { amountCents, currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  assertIntCents(a.amountCents, "a");
  assertIntCents(b.amountCents, "b");
  const sum = a.amountCents + b.amountCents;
  assertIntCents(sum, "sum");
  return { amountCents: sum, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return addMoney(a, { amountCents: -b.amountCents, currency: b.currency });
}

/** Multiply by an integer quantity (e.g. active-client count). */
export function multiplyMoney(a: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError(`quantity must be a non-negative integer, got ${quantity}`);
  }
  const product = a.amountCents * quantity;
  assertIntCents(product, "product");
  return { amountCents: product, currency: a.currency };
}

/**
 * Basis-points fee (e.g. platform transaction commission). Fractional cents
 * always round toward zero — in the customer's favor — so the platform never
 * over-collects by rounding.
 */
export function applyBasisPoints(a: Money, bps: number): Money {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new TypeError(`bps out of range: ${bps}`);
  }
  const raw = (a.amountCents * bps) / 10_000;
  const fee = raw >= 0 ? Math.floor(raw) : Math.ceil(raw);
  return { amountCents: fee, currency: a.currency };
}

export function isZero(a: Money): boolean {
  return a.amountCents === 0;
}

export function formatMoney(a: Money, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: a.currency.toUpperCase(),
  }).format(a.amountCents / 100);
}
