import { describe, expect, it } from "vitest";
import {
  addMoney,
  applyBasisPoints,
  formatMoney,
  money,
  multiplyMoney,
  subtractMoney,
} from "../src/money.js";

describe("money", () => {
  it("constructs integer-cent money", () => {
    expect(money(3499, "usd")).toEqual({ amountCents: 3499, currency: "usd" });
  });

  it("rejects non-integer cents", () => {
    expect(() => money(34.99, "usd")).toThrow(/safe integer/);
    expect(() => money(Number.NaN, "usd")).toThrow(/safe integer/);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "usd")).toThrow(/safe integer/);
  });

  it("rejects invalid currency codes", () => {
    expect(() => money(100, "USDT")).toThrow(/currency/);
    expect(() => money(100, "$")).toThrow(/currency/);
  });

  it("adds and subtracts in the same currency only", () => {
    expect(addMoney(money(250, "usd"), money(3499, "usd")).amountCents).toBe(3749);
    expect(subtractMoney(money(3499, "usd"), money(250, "usd")).amountCents).toBe(3249);
    expect(() => addMoney(money(1, "usd"), money(1, "eur"))).toThrow(/mismatch/);
  });

  it("multiplies by integer quantities (active-client fee)", () => {
    expect(multiplyMoney(money(250, "usd"), 12).amountCents).toBe(3000);
    expect(multiplyMoney(money(250, "usd"), 0).amountCents).toBe(0);
    expect(() => multiplyMoney(money(250, "usd"), 1.5)).toThrow(/integer/);
    expect(() => multiplyMoney(money(250, "usd"), -1)).toThrow(/integer/);
  });

  it("applies basis points rounding toward zero", () => {
    // 999 * 250bps = 24.975 -> 24 (customer's favor)
    expect(applyBasisPoints(money(999, "usd"), 250).amountCents).toBe(24);
    expect(applyBasisPoints(money(10000, "usd"), 0).amountCents).toBe(0);
    expect(() => applyBasisPoints(money(100, "usd"), 10001)).toThrow(/range/);
  });

  it("formats for display", () => {
    expect(formatMoney(money(3499, "usd"))).toBe("$34.99");
  });
});
