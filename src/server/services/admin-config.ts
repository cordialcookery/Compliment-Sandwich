import "server-only";

import { HttpError } from "@/src/lib/http";

const LIVE_SESSION_ONLY_MESSAGE = "Phone destination settings were removed. Compliment Sandwich now uses browser-based live sessions.";

export async function getDestinationPhone() {
  throw new HttpError(410, LIVE_SESSION_ONLY_MESSAGE);
}

export async function getDestinationPhoneSummary() {
  return {
    masked: "browser-live-only",
    allowPhoneOverride: false,
    sourceLabel: "browser live sessions"
  };
}

export async function updateDestinationPhoneOverride() {
  throw new HttpError(410, LIVE_SESSION_ONLY_MESSAGE);
}
