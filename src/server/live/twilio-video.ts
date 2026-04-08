import "server-only";

import twilio from "twilio";

import { getServerEnv } from "@/src/lib/env";

let client: ReturnType<typeof twilio> | null = null;

function getTwilioClient() {
  if (!client) {
    const env = getServerEnv();
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }

  return client;
}

export async function createLiveRoom(input: { requestId: string }) {
  const env = getServerEnv();
  const room = await getTwilioClient().video.v1.rooms.create({
    uniqueName: `compliment-${input.requestId}`,
    type: env.TWILIO_VIDEO_ROOM_TYPE,
    statusCallback: `${env.APP_URL}/api/webhooks/twilio/video?requestId=${input.requestId}`,
    statusCallbackMethod: "POST",
    maxParticipants: 2,
    emptyRoomTimeout: 1,
    unusedRoomTimeout: 1,
    maxParticipantDuration: 900,
    recordParticipantsOnConnect: false
  });

  return {
    roomName: room.uniqueName,
    roomSid: room.sid
  };
}

export async function completeLiveRoom(roomNameOrSid: string) {
  try {
    return await getTwilioClient().video.v1.rooms(roomNameOrSid).update({
      status: "completed"
    });
  } catch {
    return null;
  }
}

export function createLiveAccessToken(input: {
  identity: string;
  roomName: string;
}) {
  const env = getServerEnv();
  const AccessToken = twilio.jwt.AccessToken;
  const VideoGrant = AccessToken.VideoGrant;

  const token = new AccessToken(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_API_KEY_SID,
    env.TWILIO_API_KEY_SECRET,
    {
      identity: input.identity,
      ttl: 60 * 60
    }
  );

  token.addGrant(
    new VideoGrant({
      room: input.roomName
    })
  );

  return token.toJwt();
}

export function validateTwilioRequest(requestUrl: string, signature: string | null, formFields: Record<string, string>) {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const env = getServerEnv();
  if (!signature) {
    return false;
  }

  return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, requestUrl, formFields);
}
