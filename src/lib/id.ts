import crypto from "node:crypto";

export function createClientRequestId() {
  return crypto.randomUUID();
}
