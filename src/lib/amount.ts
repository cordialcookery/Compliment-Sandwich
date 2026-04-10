import { AMOUNT_INCREMENT_CENTS } from "@/src/lib/constants";

export type NormalizedAmount = {
  amountCents: number;
  displayAmount: string;
  isFree: boolean;
};

function coerceAmountString(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Amount must be a number.");
    }

    return value.toString();
  }

  if (typeof value !== "string") {
    throw new Error("Please enter an amount.");
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Please enter an amount.");
  }

  return normalized;
}

function parseAmountFraction(value: unknown) {
  const normalized = coerceAmountString(value);
  const match = normalized.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|(?:\.(\d+)))$/);

  if (!match) {
    throw new Error("Amount must be a number.");
  }

  if (match[1] === "-") {
    throw new Error("Amount cannot be negative.");
  }

  const whole = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const scale = 10n ** BigInt(fraction.length);

  return {
    numerator: BigInt(digits),
    scale
  };
}

export function normalizeAmountToIncrement(value: unknown): NormalizedAmount {
  const { numerator, scale } = parseAmountFraction(value);

  // Round to the nearest $0.50 using integer math so browser and server stay identical.
  const halfDollarSteps = (4n * numerator + scale) / (2n * scale);
  const amountCentsBigInt = halfDollarSteps * BigInt(AMOUNT_INCREMENT_CENTS);

  if (amountCentsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount is too large.");
  }

  const amountCents = Number(amountCentsBigInt);

  return {
    amountCents,
    displayAmount: formatCurrency(amountCents),
    isFree: amountCents === 0
  };
}

export function getSelfRequestTypeForAmount(amountCents: number) {
  return amountCents === 0 ? "self_free" : "self_paid";
}

export function validatePaidAmountCents(amountCents: number) {
  if (
    !Number.isInteger(amountCents) ||
    amountCents < AMOUNT_INCREMENT_CENTS ||
    amountCents % AMOUNT_INCREMENT_CENTS !== 0
  ) {
    throw new Error("Paid compliments must use a positive amount that rounds to $0.50 increments.");
  }
}

export function formatCurrency(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}
