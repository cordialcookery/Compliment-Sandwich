import "server-only";

import { normalizeUserNote } from "@/src/lib/user-note";

type OwnerAlertInput = {
  title: string;
  body: string;
  url?: string;
};

export type OwnerAlertRequestType = "self_paid" | "gift_paid" | "self_free";
export type OwnerAlertEvent = "request_created" | "room_created";

type OwnerRequestAlertDetailsInput = {
  event: OwnerAlertEvent;
  requestType: OwnerAlertRequestType;
  amountCents: number;
  userNote?: string | null;
  occurredAt?: Date | string | null;
};

const OWNER_ADMIN_URL = "https://compliment-sandwich.company/admin";
const REQUEST_CREATED_TITLE = "\u{1F96A} PREPARE PAYMENT";
const FREE_REQUEST_TITLE = "\u{1F96A} FREE REQUEST";
const ROOM_CREATED_TITLE = "\u{1F6AA} ROOM CREATED";
const NOTE_LABEL = "\u{1F4DD} NOTE FROM USER:";

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

function formatTimestamp(value?: Date | string | null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function formatOwnerRequestKind(requestType: OwnerAlertRequestType) {
  return requestType === "gift_paid" ? "Gift" : "For themselves";
}

export function formatOwnerRequestAmount(requestType: OwnerAlertRequestType, amountCents: number) {
  return requestType === "self_free" ? "Free" : formatMoney(amountCents);
}

export function formatOwnerRequestNote(note?: string | null) {
  return normalizeUserNote(note) ?? "(none)";
}

export function buildOwnerLifecycleAlert(input: OwnerRequestAlertDetailsInput) {
  const title = input.event === "room_created"
    ? ROOM_CREATED_TITLE
    : input.requestType === "self_free"
      ? FREE_REQUEST_TITLE
      : REQUEST_CREATED_TITLE;

  const detailLines = [
    `Type: ${formatOwnerRequestKind(input.requestType)}`,
    `Amount: ${formatOwnerRequestAmount(input.requestType, input.amountCents)}`,
    `Time: ${formatTimestamp(input.occurredAt)}`
  ];

  if (input.event === "room_created") {
    detailLines.push("", "User is ready.");
  }

  const noteLines = [
    NOTE_LABEL,
    formatOwnerRequestNote(input.userNote)
  ];

  const body = [...detailLines, "", ...noteLines, "", "Open admin"].join("\n");
  const emailText = [title, "", ...detailLines, "", ...noteLines, "", `Admin: ${OWNER_ADMIN_URL}`].join("\n");

  return {
    title,
    body,
    url: OWNER_ADMIN_URL,
    emailSubject: title,
    emailText
  } as const;
}

export async function sendOwnerAlert(input: OwnerAlertInput) {
  const base = process.env.OWNER_ALERT_URL;
  if (!base) {
    return false;
  }

  const url = `${base}/${encodeURIComponent(input.title)}/${encodeURIComponent(input.body)}?level=critical&volume=10${input.url ? `&url=${encodeURIComponent(input.url)}` : ""}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    if (!res.ok) {
      console.error("Bark alert failed:", res.status, await res.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error("Bark alert error:", err);
    return false;
  }
}