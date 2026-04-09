import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { buildCustomerJoinPath } from "@/src/lib/live-session";
import {
  authorizePayPalOrder,
  getPayPalNotConfiguredMessage,
  isPayPalConfigured
} from "@/src/server/payments/paypal";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.object({
  requestId: z.string().min(1),
  orderId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  customerRequestedVideo: z.boolean().optional().default(false)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isPayPalConfigured()) {
    return NextResponse.json({ error: getPayPalNotConfiguredMessage() }, { status: 503 });
  }

  try {
    const body = schema.parse(await request.json());
    const authorization = await authorizePayPalOrder(body.orderId);
    const complimentRequest = await complimentService.confirmAuthorizedPayment({
      requestId: body.requestId,
      provider: "paypal",
      paymentMethodType: "venmo",
      externalPaymentId: authorization.orderId,
      authorizationId: authorization.authorizationId,
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
      message: "Venmo authorized. Opening the live compliment room."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to authorize Venmo payment.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
