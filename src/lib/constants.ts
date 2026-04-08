export const MINIMUM_AMOUNT_CENTS = 50;

export const ACTIVE_REQUEST_STATUSES = [
  "payment_authorized",
  "calling",
  "answered"
] as const;

export const CURRENCY = "usd";

export const ADMIN_COOKIE_NAME = "compliment_sandwich_admin";

export const RATE_LIMIT_WINDOW_MINUTES = 5;
export const RATE_LIMIT_MAX_ATTEMPTS = 8;
