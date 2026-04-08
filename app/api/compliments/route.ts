import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseAmountToCents, validateMinimumAmount } from "@/src/lib/amount";
import { getRequestActor } from "@/src/lib/request";
import { enforceRateLimit } from "@/src/server/services/rate-limit";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.object({
  amount: z.union([z.string(), z.number()]),
  provider: z.enum(["stripe", "paypal"]),
  paymentMethodType: z.enum(["card", "apple_pay", "google_pay", "venmo", "unknown"]),
  clientRequestId: z.string().min(8)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = getRequestActor(request);
    await enforceRateLimit("compliments:start", actor);

    const body = schema.parse(await request.json());
    const amountCents = parseAmountToCents(body.amount);
    validateMinimumAmount(amountCents);

    const complimentRequest = await complimentService.createPendingRequest({
      clientRequestId: body.clientRequestId,
      amountCents,
      customerPhoneRaw: null,
      provider: body.provider,
      paymentMethodType: body.paymentMethodType
    });

    return NextResponse.json({
      request: {
        id: complimentRequest.id,
        amountCents: complimentRequest.amountCents,
        status: complimentRequest.status
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start compliment request.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
