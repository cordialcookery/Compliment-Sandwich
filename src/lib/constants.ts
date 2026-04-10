export const MINIMUM_PAID_AMOUNT_CENTS = 50;

export const ACTIVE_REQUEST_STATUSES = [
  "calling",
  "answered"
] as const;

export const MAX_WAITING_QUEUE_SIZE = 5;
export const DEFAULT_QUEUE_REQUEST_EXPIRATION_MINUTES = 30;

export const CURRENCY = "usd";

export const ADMIN_COOKIE_NAME = "compliment_sandwich_admin";

export const RATE_LIMIT_WINDOW_MINUTES = 5;
export const RATE_LIMIT_MAX_ATTEMPTS = 8;
