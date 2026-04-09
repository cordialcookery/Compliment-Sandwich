import "server-only";

import twilio from "twilio";

import { prisma } from "@/lib/prisma";
import { getServerEnv } from "@/src/lib/env";

let smsClient: ReturnType<typeof twilio> | null = null;

function getSmsClient() {
  if (!smsClient) {
    const env = getServerEnv();
    smsClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }

  return smsClient;
}

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

export async function sendOwnerNewRequestSms(input: {
  requestId: string;
  amountCents: number;
}) {
  const env = getServerEnv();

  if (!env.TWILIO_PHONE_NUMBER || !env.OWNER_DESTINATION_PHONE_E164) {
    console.info("[Compliment Sandwich SMS] Skipping owner alert because SMS env vars are not configured.", {
      ownerDestinationConfigured: Boolean(env.OWNER_DESTINATION_PHONE_E164),
      requestId: input.requestId,
      twilioPhoneConfigured: Boolean(env.TWILIO_PHONE_NUMBER)
    });
    return { sent: false as const, reason: "not_configured" as const };
  }

  const request = await prisma.complimentRequest.findUnique({
    where: { id: input.requestId },
    select: {
      amountCents: true,
      id: true,
      ownerAlertSentAt: true
    }
  });

  if (!request) {
    console.info("[Compliment Sandwich SMS] Skipping owner alert because the request no longer exists.", {
      requestId: input.requestId
    });
    return { sent: false as const, reason: "missing_request" as const };
  }

  if (request.ownerAlertSentAt) {
    console.info("[Compliment Sandwich SMS] Owner alert already sent for this request.", {
      requestId: request.id,
      sentAt: request.ownerAlertSentAt.toISOString()
    });
    return { sent: false as const, reason: "already_sent" as const };
  }

  const adminUrl = new URL("/admin", env.APP_URL).toString();
  const messageBody = `New compliment request: ${formatMoney(request.amountCents)}. Request ${request.id}. Open ${adminUrl}`;

  try {
    const message = await getSmsClient().messages.create({
      body: messageBody,
      from: env.TWILIO_PHONE_NUMBER,
      to: env.OWNER_DESTINATION_PHONE_E164
    });

    await prisma.complimentRequest.update({
      where: { id: request.id },
      data: {
        ownerAlertSentAt: new Date()
      }
    });

    console.info("[Compliment Sandwich SMS] Owner alert sent.", {
      messageSid: message.sid,
      requestId: request.id
    });

    return { sent: true as const, sid: message.sid };
  } catch (error) {
    console.error("[Compliment Sandwich SMS] Failed to send owner alert.", error, {
      requestId: request.id
    });
    return { sent: false as const, reason: "send_failed" as const };
  }
}
