import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createPayPalAuthorizeOrder } from "@/src/server/payments/paypal";
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

    const order = await createPayPalAuthorizeOrder({
      amountCents: complimentRequest.amountCents,
      complimentRequestId: complimentRequest.id
    });

    return NextResponse.json({ orderId: order.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create PayPal order." },
      { status: 400 }
    );
  }
}
