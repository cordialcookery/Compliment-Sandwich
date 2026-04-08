import "server-only";

export type CreateComplimentCallInput = {
  complimentRequestId: string;
  customerPhoneE164: string;
  destinationPhoneE164: string;
};

export async function createComplimentCall(_: CreateComplimentCallInput) {
  throw new Error("Legacy phone-call delivery has been replaced by browser-based live sessions.");
}

export function buildOwnerDialTwiml() {
  return "<Response><Say>Compliment Sandwich moved to browser live sessions.</Say><Hangup/></Response>";
}

export function validateTwilioWebhook() {
  return false;
}
