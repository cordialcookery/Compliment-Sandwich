import { NextRequest, NextResponse } from "next/server";

import { getServerEnv } from "@/src/lib/env";
import { getStripeWebhookClient } from "@/src/server/payments/stripe";
import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  try {
    const env = getServerEnv();
    const signature = request.headers.get("stripe-signature");
    const stripe = getStripeWebhookClient();
    const event = env.STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(rawBody, signature || "", env.STRIPE_WEBHOOK_SECRET)
      : JSON.parse(rawBody);

    if (event.type === "payment_intent.canceled") {
      await complimentService.syncPaymentAttemptStatus({
        provider: "stripe",
        externalPaymentId: event.data.object.id,
        status: "canceled",
        failureReason: "Stripe canceled the authorization."
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      await complimentService.syncPaymentAttemptStatus({
        provider: "stripe",
        externalPaymentId: event.data.object.id,
        status: "failed",
        failureReason: event.data.object.last_payment_error?.message || "Stripe reported a payment failure."
      });
    }

    if (event.type === "payment_intent.succeeded") {
      await complimentService.syncPaymentAttemptStatus({
        provider: "stripe",
        externalPaymentId: event.data.object.id,
        status: "captured"
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Stripe webhook." },
      { status: 400 }
    );
  }
}
