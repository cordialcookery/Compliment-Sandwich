import "server-only";

import { CURRENCY } from "@/src/lib/constants";
import { getServerEnv } from "@/src/lib/env";

const PAYPAL_BASE_URL = process.env.NODE_ENV === "production"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

type PayPalAccessTokenResponse = {
  access_token: string;
};

type PayPalOrderResponse = {
  id: string;
  status: string;
  purchase_units?: Array<{
    payments?: {
      authorizations?: Array<{
        id: string;
        status: string;
      }>;
    };
  }>;
};

async function getAccessToken() {
  const env = getServerEnv();
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials"
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Unable to get PayPal access token.");
  }

  const payload = (await response.json()) as PayPalAccessTokenResponse;
  return payload.access_token;
}

async function paypalFetch(path: string, init: RequestInit = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `PayPal request failed for ${path}`);
  }

  return response.json();
}

type CreatePayPalOrderInput = {
  amountCents: number;
  complimentRequestId: string;
};

export async function createPayPalAuthorizeOrder(input: CreatePayPalOrderInput) {
  return (await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.complimentRequestId,
          amount: {
            currency_code: CURRENCY.toUpperCase(),
            value: (input.amountCents / 100).toFixed(2)
          },
          description: "Compliment Sandwich live compliment request"
        }
      ],
      application_context: {
        brand_name: "Compliment Sandwich",
        user_action: "CONTINUE",
        shipping_preference: "NO_SHIPPING"
      }
    })
  })) as PayPalOrderResponse;
}

export async function authorizePayPalOrder(orderId: string) {
  const response = (await paypalFetch(`/v2/checkout/orders/${orderId}/authorize`, {
    method: "POST",
    body: JSON.stringify({})
  })) as PayPalOrderResponse;

  const authorizationId = response.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authorizationId) {
    throw new Error("PayPal did not return an authorization id.");
  }

  return {
    orderId: response.id,
    authorizationId
  };
}

export async function capturePayPalAuthorization(authorizationId: string) {
  return paypalFetch(`/v2/payments/authorizations/${authorizationId}/capture`, {
    method: "POST",
    body: JSON.stringify({
      is_final_capture: true
    })
  });
}

export async function voidPayPalAuthorization(authorizationId: string) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}/v2/payments/authorizations/${authorizationId}/void`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({}),
    cache: "no-store"
  });

  if (response.status === 204 || response.status === 200) {
    return true;
  }

  const text = await response.text();
  throw new Error(text || "Unable to void PayPal authorization.");
}

export async function verifyPayPalWebhook(headers: Headers, body: unknown) {
  const env = getServerEnv();
  if (!env.PAYPAL_WEBHOOK_ID) {
    return true;
  }

  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: body
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as { verification_status?: string };
  return payload.verification_status === "SUCCESS";
}
