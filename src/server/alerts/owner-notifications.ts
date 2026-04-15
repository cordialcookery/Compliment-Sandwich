import "server-only";

import { prisma } from "@/lib/prisma";
import { buildOwnerLifecycleAlert, sendOwnerAlert } from "@/src/lib/owner-alert";
import { sendOwnerNewRequestEmail } from "@/src/server/alerts/resend-email";

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

  const emailResult = await sendOwnerNewRequestEmail({
    requestId: request.id,
    amountCents: request.amountCents
  });
  const barkSent = await sendOwnerAlert({
    title: alert.title,
    body: alert.body,
    url: alert.url
  });

  return {
    sent: emailResult.sent || barkSent,
    barkSent,
    emailSent: emailResult.sent
  };
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

  const barkSent = await sendOwnerAlert({
    title: alert.title,
    body: alert.body,
    url: alert.url
  });

  return {
    sent: barkSent,
    barkSent,
    emailSent: false as const
  };
}
