import "server-only";

type OwnerAlertInput = {
  title: string;
  body: string;
  url?: string;
};

type OwnerAlertRequestType = "self_paid" | "gift_paid" | "self_free";

type OwnerRequestAlertDetailsInput = {
  requestType: OwnerAlertRequestType;
  amountCents: number;
  status?: string | null;
};

const OWNER_ALERT_TITLE = "\u{1F96A} New Compliment Request";
const SEPARATOR = " \u2022 ";
const OWNER_ADMIN_URL = "https://compliment-sandwich.company/admin";

export function formatOwnerAlertDetails(input: OwnerRequestAlertDetailsInput) {
  const requestLabel =
    input.requestType === "gift_paid"
      ? `Gift${SEPARATOR}Paid`
      : input.requestType === "self_free"
        ? `For themself${SEPARATOR}Free`
        : `For themself${SEPARATOR}Paid`;

  const parts = [requestLabel];

  if (input.requestType !== "self_free") {
    parts.push(formatMoney(input.amountCents));
  }

  if (input.status === "queued") {
    parts.push("Queued");
  }

  return `${parts.join(SEPARATOR)}\nOpen admin`;
}

export async function sendOwnerAlert(input: OwnerAlertInput) {
  const base = process.env.OWNER_ALERT_URL;
  if (!base) {
    return;
  }

  const url = `${base}/${encodeURIComponent(input.title)}/${encodeURIComponent(input.body)}?level=critical&volume=10${input.url ? `&url=${encodeURIComponent(input.url)}` : ""}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) {
      console.error("Bark alert failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Bark alert error:", err);
  }
}

export function buildOwnerRequestAlert(input: OwnerRequestAlertDetailsInput) {
  return {
    title: OWNER_ALERT_TITLE,
    body: formatOwnerAlertDetails(input),
    url: OWNER_ADMIN_URL
  } satisfies OwnerAlertInput;
}

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}
