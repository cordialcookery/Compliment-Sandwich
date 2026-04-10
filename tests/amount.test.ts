import { describe, expect, it } from "vitest";

import {
  getSelfRequestTypeForAmount,
  normalizeAmountForRequest,
  validatePaidAmountCents
} from "@/src/lib/amount";

describe("amount normalization", () => {
  it("treats anything under fifty cents as free and keeps paid amounts at exact cents", () => {
    expect(normalizeAmountForRequest("0").amountCents).toBe(0);
    expect(normalizeAmountForRequest("0.49").amountCents).toBe(0);
    expect(normalizeAmountForRequest("0.50").amountCents).toBe(50);
    expect(normalizeAmountForRequest("1.26").amountCents).toBe(126);
    expect(normalizeAmountForRequest("3.74").amountCents).toBe(374);
  });

  it("uses the thresholded zero amount for the free self flow", () => {
    const normalized = normalizeAmountForRequest("0.10");

    expect(normalized.amountCents).toBe(0);
    expect(getSelfRequestTypeForAmount(normalized.amountCents)).toBe("self_free");
  });

  it("uses the exact paid amount for the paid self flow", () => {
    const normalized = normalizeAmountForRequest("1.26");

    expect(normalized.amountCents).toBe(126);
    expect(getSelfRequestTypeForAmount(normalized.amountCents)).toBe("self_paid");
  });

  it("treats negative numbers as zero and still rejects zero as a paid amount", () => {
    expect(normalizeAmountForRequest("-1").amountCents).toBe(0);
    expect(() => validatePaidAmountCents(0)).toThrow("Paid compliments must use at least $0.50");
  });
});
