import { NextRequest, NextResponse } from "next/server";

import { getFormFields } from "@/src/lib/request";
import { validateTwilioRequest } from "@/src/server/live/twilio-video";
import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get("requestId");
  if (!requestId) {
    return NextResponse.json({ error: "Missing request id." }, { status: 400 });
  }

  const fields = await getFormFields(request);
  const isValid = validateTwilioRequest(request.url, request.headers.get("x-twilio-signature"), fields);
  if (!isValid) {
    return NextResponse.json({ error: "Invalid Twilio signature." }, { status: 400 });
  }

  if (!fields.StatusCallbackEvent) {
    return NextResponse.json({ error: "Missing Twilio status callback event." }, { status: 400 });
  }

  await complimentService.handleLiveRoomEvent({
    requestId,
    statusCallbackEvent: fields.StatusCallbackEvent,
    roomName: fields.RoomName ?? null,
    roomSid: fields.RoomSid ?? null,
    participantIdentity: fields.ParticipantIdentity ?? null,
    participantDuration: fields.ParticipantDuration ? Number(fields.ParticipantDuration) : null,
    trackKind: fields.TrackKind ?? null
  });

  return NextResponse.json({ received: true });
}
