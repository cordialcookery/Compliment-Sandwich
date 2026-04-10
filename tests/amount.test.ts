import { describe, expect, it } from "vitest";

import {
  getSelfRequestTypeForAmount,
  normalizeAmountToIncrement,
  validatePaidAmountCents
} from "@/src/lib/amount";

describe("amount normalization", () => {
  it("rounds to the nearest fifty cents with halfway values rounding up", () => {
    expect(normalizeAmountToIncrement("0").amountCents).toBe(0);
    expect(normalizeAmountToIncrement("0.10").amountCents).toBe(0);
    expect(normalizeAmountToIncrement("0.24").amountCents).toBe(0);
    expect(normalizeAmountToIncrement("0.25").amountCents).toBe(50);
    expect(normalizeAmountToIncrement("0.26").amountCents).toBe(50);
    expect(normalizeAmountToIncrement("0.74").amountCents).toBe(50);
    expect(normalizeAmountToIncrement("1.26").amountCents).toBe(150);
    expect(normalizeAmountToIncrement("3.74").amountCents).toBe(350);
    expect(normalizeAmountToIncrement("3.75").amountCents).toBe(400);
  });

  it("uses the rounded zero amount for the free self flow", () => {
    const normalized = normalizeAmountToIncrement("0.10");

    expect(normalized.amountCents).toBe(0);
    expect(getSelfRequestTypeForAmount(normalized.amountCents)).toBe("self_free");
  });

  it("uses the rounded paid amount for the paid self flow", () => {
    const normalized = normalizeAmountToIncrement("1.26");

    expect(normalized.amountCents).toBe(150);
    expect(getSelfRequestTypeForAmount(normalized.amountCents)).toBe("self_paid");
  });

  it("rejects invalid negative paid amounts", () => {
    expect(() => normalizeAmountToIncrement("-1")).toThrow("Amount cannot be negative");
    expect(() => validatePaidAmountCents(0)).toThrow("Paid compliments must use a positive amount");
  });
});
