import { MINIMUM_PAID_AMOUNT_CENTS } from "@/src/lib/constants";

export type NormalizedAmount = {
  amountCents: number;
  displayAmount: string;
  isFree: boolean;
};

type ParsedAmountParts = {
  negative: boolean;
  numerator: bigint;
  scale: bigint;
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

function parseAmountParts(value: unknown): ParsedAmountParts {
  const normalized = coerceAmountString(value);
  const match = normalized.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|(?:\.(\d+)))$/);

  if (!match) {
    throw new Error("Amount must be a number.");
  }

  const whole = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";

  return {
    negative: match[1] === "-",
    numerator: BigInt(digits),
    scale: 10n ** BigInt(fraction.length)
  };
}

export function normalizeAmountForRequest(value: unknown): NormalizedAmount {
  const parsed = parseAmountParts(value);

  // Anything below the paid threshold becomes the free flow before cent conversion.
  if (parsed.negative || parsed.numerator === 0n || parsed.numerator * 100n < parsed.scale * BigInt(MINIMUM_PAID_AMOUNT_CENTS)) {
    return {
      amountCents: 0,
      displayAmount: formatCurrency(0),
      isFree: true
    };
  }

  const amountCentsBigInt = (parsed.numerator * 100n + parsed.scale / 2n) / parsed.scale;
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
  if (!Number.isInteger(amountCents) || amountCents < MINIMUM_PAID_AMOUNT_CENTS) {
    throw new Error("Paid compliments must use at least $0.50.");
  }
}

export function formatCurrency(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}
