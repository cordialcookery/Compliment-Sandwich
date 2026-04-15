import "server-only";

import { prisma } from "@/lib/prisma";
import { buildOwnerLifecycleAlert, sendOwnerAlert } from "@/src/lib/owner-alert";
import { sendOwnerLifecycleEmail } from "@/src/server/alerts/resend-email";

async function sendChannels(input: {
  requestId: string;
  title: string;
  body: string;
  url: string;
  emailSubject: string;
  emailText: string;
}) {
  const emailResult = await sendOwnerLifecycleEmail({
    requestId: input.requestId,
    subject: input.emailSubject,
    text: input.emailText
  });
  const barkSent = await sendOwnerAlert({
    title: input.title,
    body: input.body,
    url: input.url
  });

  return {
    sent: emailResult.sent || barkSent,
    barkSent,
    emailSent: emailResult.sent
  };
}

export async function sendPreparedOwnerNotification(input: { requestId: string }) {
  const request = await prisma.complimentRequest.findUnique({
    where: { id: input.requestId },
    select: {
      id: true,
      amountCents: true,
      requestType: true,
      publicMessage: true,
      createdAt: true,
      ownerAlertSentAt: true
    }
  });

  if (!request) {
    return { sent: false as const, reason: "missing_request" as const };
  }

  if (request.ownerAlertSentAt) {
    return { sent: false as const, reason: "already_sent" as const };
  }

  const alert = buildOwnerLifecycleAlert({
    event: "request_created",
    requestType: request.requestType,
    amountCents: request.amountCents,
    userNote: request.publicMessage,
    occurredAt: request.createdAt
  });

  const result = await sendChannels({
    requestId: request.id,
    ...alert
  });

  if (result.sent) {
    await prisma.complimentRequest.update({
      where: { id: request.id },
      data: {
        ownerAlertSentAt: new Date()
      }
    });
  }

  return result;
}

export async function sendRoomCreatedOwnerNotification(input: { requestId: string; amountCents: number }) {
  const request = await prisma.complimentRequest.findUnique({
    where: { id: input.requestId },
    select: {
      id: true,
      amountCents: true,
      requestType: true,
      publicMessage: true
    }
  });

  if (!request) {
    return { sent: false as const, reason: "missing_request" as const };
  }

  const alert = buildOwnerLifecycleAlert({
    event: "room_created",
    requestType: request.requestType,
    amountCents: request.amountCents,
    userNote: request.publicMessage,
    occurredAt: new Date()
  });

  return sendChannels({
    requestId: request.id,
    ...alert
  });
}