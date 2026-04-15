export const USER_NOTE_MAX_LENGTH = 240;

export function normalizeUserNote(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > USER_NOTE_MAX_LENGTH) {
    throw new Error(`User note must be ${USER_NOTE_MAX_LENGTH} characters or fewer.`);
  }

  return normalized;
}