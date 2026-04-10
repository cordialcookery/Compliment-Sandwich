import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseAmountToCents, validateMinimumAmount } from "@/src/lib/amount";
import { getRequestActor } from "@/src/lib/request";
import { enforceRateLimit } from "@/src/server/services/rate-limit";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.discriminatedUnion("requestType", [
  z.object({
    requestType: z.literal("self_paid"),
    amount: z.union([z.string(), z.number()]),
    provider: z.enum(["stripe", "paypal"]),
    paymentMethodType: z.enum(["card", "apple_pay", "google_pay", "venmo", "unknown"]),
    clientRequestId: z.string().min(8)
  }),
  z.object({
    requestType: z.literal("gift_paid"),
    amount: z.union([z.string(), z.number()]),
    provider: z.enum(["stripe", "paypal"]),
    paymentMethodType: z.enum(["card", "apple_pay", "google_pay", "venmo", "unknown"]),
    clientRequestId: z.string().min(8)
  }),
  z.object({
    requestType: z.literal("self_free"),
    clientRequestId: z.string().min(8),
    email: z.string().email(),
    customerRequestedVideo: z.boolean().optional().default(false),
    browserMarker: z.string().min(8).optional().nullable()
  })
]);

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = getRequestActor(request);
    await enforceRateLimit("compliments:start", actor);

    const body = schema.parse(await request.json());

    if (body.requestType === "self_free") {
      await enforceRateLimit("compliments:start-free", actor);
      const freeRequest = await complimentService.createFreeRequest({
        clientRequestId: body.clientRequestId,
        email: body.email,
        customerRequestedVideo: body.customerRequestedVideo,
        actor,
        browserMarker: body.browserMarker,
        userAgent: request.headers.get("user-agent")
      });

      return NextResponse.json({
        request: {
          id: freeRequest.request.id,
          amountCents: freeRequest.request.amountCents,
          status: freeRequest.request.status,
          requestType: freeRequest.request.requestType,
          queuePriority: freeRequest.request.queuePriority
        },
        nextStep: "waiting_room",
        waitPath: freeRequest.waitPath,
        message: freeRequest.emailSent
          ? "Free compliment request created. Check your email for your access link."
          : "Free compliment request created. We could not confirm the email send, so keep this page open and use the waiting link now.",
        emailSent: freeRequest.emailSent
      });
    }

    const amountCents = parseAmountToCents(body.amount);
    validateMinimumAmount(amountCents);

    const complimentRequest = await complimentService.createPendingRequest({
      clientRequestId: body.clientRequestId,
      amountCents,
      customerPhoneRaw: null,
      provider: body.provider,
      paymentMethodType: body.paymentMethodType,
      requestType: body.requestType
    });

    return NextResponse.json({
      request: {
        id: complimentRequest.id,
        amountCents: complimentRequest.amountCents,
        status: complimentRequest.status,
        requestType: complimentRequest.requestType,
        queuePriority: complimentRequest.queuePriority
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start compliment request.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
