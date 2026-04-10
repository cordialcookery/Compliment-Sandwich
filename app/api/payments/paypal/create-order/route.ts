import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import {
  createPayPalAuthorizeOrder,
  getPayPalNotConfiguredMessage,
  isPayPalConfigured
} from "@/src/server/payments/paypal";

const schema = z.object({
  requestId: z.string().min(1)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isPayPalConfigured()) {
    return NextResponse.json({ error: getPayPalNotConfiguredMessage() }, { status: 503 });
  }

  try {
    const body = schema.parse(await request.json());
    const complimentRequest = await prisma.complimentRequest.findUnique({
      where: { id: body.requestId }
    });

    if (!complimentRequest) {
      return NextResponse.json({ error: "Compliment request not found." }, { status: 404 });
    }

    if (complimentRequest.requestType === "self_free") {
      return NextResponse.json({ error: "Free compliments do not create PayPal authorizations." }, { status: 409 });
    }

    const order = await createPayPalAuthorizeOrder({
      amountCents: complimentRequest.amountCents,
      complimentRequestId: complimentRequest.id
    });

    return NextResponse.json({ orderId: order.id });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create PayPal order." },
      { status }
    );
  }
}
