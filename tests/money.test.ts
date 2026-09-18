import { describe, expect, it } from "vitest";
import { formatUsd, toMicroUsd } from "../src/money.js";

describe("money", () => {
  it("converts dollars to integer micro-USD without float drift", () => {
    expect(toMicroUsd(0.1)).toBe(100_000);
    expect(toMicroUsd(0.2)).toBe(200_000);
    expect(toMicroUsd(0.1) + toMicroUsd(0.2)).toBe(300_000);
    expect(toMicroUsd(1.234567)).toBe(1_234_567);
  });
  it("rejects negative or non-finite input", () => {
    expect(() => toMicroUsd(-1)).toThrow();
    expect(() => toMicroUsd(Number.NaN)).toThrow();
  });
  it("formats for display with two decimals", () => {
    expect(formatUsd(1_234_567)).toBe("1.23");
    expect(formatUsd(0)).toBe("0.00");
  });
});
