import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { buildCustomerJoinPath } from "@/src/lib/live-session";
import { retrieveStripePaymentIntent } from "@/src/server/payments/stripe";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.object({
  requestId: z.string().min(1),
  paymentIntentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  customerRequestedVideo: z.boolean().optional().default(false)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = schema.parse(await request.json());
    const paymentIntent = await retrieveStripePaymentIntent(body.paymentIntentId);

    if (paymentIntent.metadata.complimentRequestId !== body.requestId) {
      return NextResponse.json({ error: "Payment intent does not belong to this request." }, { status: 409 });
    }

    if (paymentIntent.status !== "requires_capture") {
      return NextResponse.json(
        { error: "Stripe payment authorization was not ready for manual capture." },
        { status: 409 }
      );
    }

    const complimentRequest = await complimentService.confirmAuthorizedPayment({
      requestId: body.requestId,
      provider: "stripe",
      paymentMethodType: "card",
      externalPaymentId: paymentIntent.id,
      authorizationId: paymentIntent.id,
      idempotencyKey: body.idempotencyKey,
      customerRequestedVideo: body.customerRequestedVideo
    });

    if (!complimentRequest.liveSession) {
      return NextResponse.json({ error: "The live compliment room was not created." }, { status: 502 });
    }

    return NextResponse.json({
      requestId: complimentRequest.id,
      status: complimentRequest.status,
      joinPath: buildCustomerJoinPath(complimentRequest.id, complimentRequest.liveSession.customerJoinKey),
      message: "Payment authorized. Opening the live compliment room."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to confirm Stripe payment.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
