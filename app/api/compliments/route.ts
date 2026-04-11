import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSelfRequestTypeForAmount, normalizeAmountForRequest } from "@/src/lib/amount";
import { buildOwnerRequestAlert, sendOwnerAlert } from "@/src/lib/owner-alert";
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

const ENABLE_ALERTS = true;

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

      if (ENABLE_ALERTS) {
        await sendOwnerAlert(
          buildOwnerRequestAlert({
            requestType: freeRequest.request.requestType,
            amountCents: freeRequest.request.amountCents,
            status: freeRequest.request.status
          })
        );
      }

      return NextResponse.json({
        request: {
          id: freeRequest.request.id,
          amountCents: freeRequest.request.amountCents,
          status: freeRequest.request.status,
          requestType: freeRequest.request.requestType,
          queuePriority: freeRequest.request.queuePriority
        },
        nextStep: "email_confirmation",
        message: freeRequest.emailSent
          ? "Check your email for your access link. Free compliments use an emailed link for entry. Paid requests may have less wait."
          : "We could not confirm the email delivery. Free compliments use an emailed link for entry, so please try again in a minute.",
        emailSent: freeRequest.emailSent
      });
    }

    const normalizedAmount = normalizeAmountForRequest(body.amount);

    if (body.requestType === "gift_paid" && normalizedAmount.amountCents === 0) {
      throw new Error("Gift compliments require a paid amount.");
    }

    if (body.requestType === "self_paid" && getSelfRequestTypeForAmount(normalizedAmount.amountCents) === "self_free") {
      throw new Error("That amount is under $0.50. Enter your email to use the free compliment flow.");
    }

    const complimentRequest = await complimentService.createPendingRequest({
      clientRequestId: body.clientRequestId,
      amountCents: normalizedAmount.amountCents,
      customerPhoneRaw: null,
      provider: body.provider,
      paymentMethodType: body.paymentMethodType,
      requestType: body.requestType
    });

    if (ENABLE_ALERTS) {
      await sendOwnerAlert(
        buildOwnerRequestAlert({
          requestType: complimentRequest.requestType,
          amountCents: complimentRequest.amountCents,
          status: complimentRequest.status
        })
      );
    }

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
