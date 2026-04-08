import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createStripeManualCaptureIntent } from "@/src/server/payments/stripe";
import { prisma } from "@/src/server/prisma";

const schema = z.object({
  requestId: z.string().min(1)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = schema.parse(await request.json());
    const complimentRequest = await prisma.complimentRequest.findUnique({
      where: { id: body.requestId }
    });

    if (!complimentRequest) {
      return NextResponse.json({ error: "Compliment request not found." }, { status: 404 });
    }

    const paymentIntent = await createStripeManualCaptureIntent({
      amountCents: complimentRequest.amountCents,
      clientRequestId: complimentRequest.clientRequestId,
      complimentRequestId: complimentRequest.id
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create Stripe payment intent." },
      { status: 400 }
    );
  }
}
