import "server-only";

import Stripe from "stripe";

import { CURRENCY } from "@/src/lib/constants";
import { getServerEnv } from "@/src/lib/env";

let stripeClient: Stripe | null = null;

function getStripeClient() {
  if (!stripeClient) {
    stripeClient = new Stripe(getServerEnv().STRIPE_SECRET_KEY);
  }

  return stripeClient;
}

type CreateStripeIntentInput = {
  amountCents: number;
  clientRequestId: string;
  complimentRequestId: string;
};

export async function createStripeManualCaptureIntent(input: CreateStripeIntentInput) {
  const stripe = getStripeClient();

  return stripe.paymentIntents.create(
    {
      amount: input.amountCents,
      currency: CURRENCY,
      capture_method: "manual",
      automatic_payment_methods: {
        enabled: true
      },
      metadata: {
        clientRequestId: input.clientRequestId,
        complimentRequestId: input.complimentRequestId
      },
      description: "Compliment Sandwich live compliment request"
    },
    {
      idempotencyKey: `stripe-intent-${input.clientRequestId}`
    }
  );
}

export async function retrieveStripePaymentIntent(paymentIntentId: string) {
  return getStripeClient().paymentIntents.retrieve(paymentIntentId);
}

export async function captureStripePaymentIntent(paymentIntentId: string) {
  return getStripeClient().paymentIntents.capture(paymentIntentId);
}

export async function cancelStripePaymentIntent(paymentIntentId: string) {
  try {
    return await getStripeClient().paymentIntents.cancel(paymentIntentId);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      return null;
    }
    throw error;
  }
}

export function getStripeWebhookClient() {
  return getStripeClient();
}
