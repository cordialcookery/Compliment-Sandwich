import { NextRequest, NextResponse } from "next/server";

import { verifyPayPalWebhook } from "@/src/server/payments/paypal";
import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const isValid = await verifyPayPalWebhook(request.headers, body);
    if (!isValid) {
      return NextResponse.json({ error: "Invalid PayPal webhook." }, { status: 400 });
    }

    const resourceId = body.resource?.id;
    if (!resourceId) {
      return NextResponse.json({ received: true });
    }

    if (body.event_type === "PAYMENT.AUTHORIZATION.CAPTURED") {
      await complimentService.syncPaymentAttemptStatus({
        provider: "paypal",
        externalPaymentId: resourceId,
        status: "captured"
      });
    }

    if (body.event_type === "PAYMENT.AUTHORIZATION.VOIDED") {
      await complimentService.syncPaymentAttemptStatus({
        provider: "paypal",
        externalPaymentId: resourceId,
        status: "canceled",
        failureReason: "PayPal authorization was voided."
      });
    }

    if (body.event_type === "PAYMENT.AUTHORIZATION.DENIED") {
      await complimentService.syncPaymentAttemptStatus({
        provider: "paypal",
        externalPaymentId: resourceId,
        status: "failed",
        failureReason: "PayPal denied the authorization."
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid PayPal webhook." },
      { status: 400 }
    );
  }
}
