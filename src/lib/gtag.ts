declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const GOOGLE_ADS_SEND_TO = "AW-18082879334/tBT0CL7oyZocEOauy65D";
const CONVERSION_STORAGE_PREFIX = "compliment-sandwich-google-ads-conversion";

type GoogleAdsConversionInput = {
  transactionId: string;
};

function getStorageKey(transactionId: string) {
  return `${CONVERSION_STORAGE_PREFIX}:${transactionId}`;
}

export function trackGoogleAdsConversion(input: GoogleAdsConversionInput) {
  if (typeof window === "undefined") {
    return false;
  }

  const storageKey = getStorageKey(input.transactionId);
  if (window.localStorage.getItem(storageKey) === "sent") {
    return true;
  }

  if (typeof window.gtag !== "function") {
    return false;
  }

  window.gtag("event", "conversion", {
    send_to: GOOGLE_ADS_SEND_TO,
    transaction_id: input.transactionId
  });
  window.localStorage.setItem(storageKey, "sent");
  return true;
}