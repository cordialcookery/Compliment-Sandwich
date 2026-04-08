import { MINIMUM_AMOUNT_CENTS } from "@/src/lib/constants";

export function parseAmountToCents(value: unknown): number {
  if (typeof value === "number") {
    return Math.round(value * 100);
  }

  if (typeof value !== "string") {
    throw new Error("Please enter an amount.");
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Please enter an amount.");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error("Amount must be a number.");
  }

  return Math.round(parsed * 100);
}

export function validateMinimumAmount(amountCents: number) {
  if (!Number.isInteger(amountCents) || amountCents < MINIMUM_AMOUNT_CENTS) {
    throw new Error("Amount must be at least $0.50.");
  }
}

export function formatCurrency(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}
