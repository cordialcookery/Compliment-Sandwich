import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { buildCustomerJoinPath } from "@/src/lib/live-session";
import { getRequestActor } from "@/src/lib/request";
import { enforceRateLimit } from "@/src/server/services/rate-limit";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.object({
  customerRequestedVideo: z.boolean().optional().default(false)
});

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ giftToken: string }> }
) {
  try {
    const actor = getRequestActor(request);
    await enforceRateLimit("gifts:redeem", actor);

    const { giftToken } = await context.params;
    const body = schema.parse(await request.json());
    const complimentRequest = await complimentService.redeemGift({
      giftToken,
      customerRequestedVideo: body.customerRequestedVideo
    });

    if (complimentRequest.liveSession) {
      return NextResponse.json({
        requestId: complimentRequest.id,
        status: complimentRequest.status,
        nextStep: "join_room",
        joinPath: buildCustomerJoinPath(complimentRequest.id, complimentRequest.liveSession.customerJoinKey),
        message: "Opening the gifted compliment room."
      });
    }

    if (complimentRequest.status === "queued") {
      return NextResponse.json({
        requestId: complimentRequest.id,
        status: complimentRequest.status,
        nextStep: "queued",
        message: "This gifted compliment joined the line."
      });
    }

    return NextResponse.json({ error: "The live compliment room was not ready." }, { status: 502 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to redeem this gift link.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
