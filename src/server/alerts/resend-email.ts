import "server-only";

import { Resend } from "resend";

import { prisma } from "@/lib/prisma";
import { getEmailEnv } from "@/src/lib/env";

let resendClient: Resend | null = null;

function getEmailClient() {
  if (!resendClient) {
    const env = getEmailEnv();

    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required to send email.");
    }

    resendClient = new Resend(env.RESEND_API_KEY);
  }

  return resendClient;
}

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

export function isOwnerAlertConfigured() {
  const env = getEmailEnv();
  return Boolean(env.RESEND_API_KEY && env.OWNER_ALERT_EMAIL && env.ALERT_FROM_EMAIL);
}

export function isCustomerEmailDeliveryConfigured() {
  const env = getEmailEnv();
  return Boolean(env.RESEND_API_KEY && env.ALERT_FROM_EMAIL);
}

export async function sendOwnerNewRequestEmail(input: {
  requestId: string;
  amountCents: number;
}) {
  const env = getEmailEnv();

  if (!isOwnerAlertConfigured()) {
    console.info("[Compliment Sandwich email] Skipping owner alert because email env vars are not configured.", {
      alertFromConfigured: Boolean(env.ALERT_FROM_EMAIL),
      ownerAlertEmailConfigured: Boolean(env.OWNER_ALERT_EMAIL),
      requestId: input.requestId,
      resendConfigured: Boolean(env.RESEND_API_KEY)
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
    console.info("[Compliment Sandwich email] Skipping owner alert because the request no longer exists.", {
      requestId: input.requestId
    });
    return { sent: false as const, reason: "missing_request" as const };
  }

  if (request.ownerAlertSentAt) {
    console.info("[Compliment Sandwich email] Owner alert already sent for this request.", {
      requestId: request.id,
      sentAt: request.ownerAlertSentAt.toISOString()
    });
    return { sent: false as const, reason: "already_sent" as const };
  }

  const adminUrl = new URL("/admin", env.APP_URL).toString();
  const subject = "New compliment request";
  const text = [
    "A new compliment request is ready.",
    `Amount: ${formatMoney(request.amountCents)}`,
    `Request ID: ${request.id}`,
    `Admin dashboard: ${adminUrl}`
  ].join("\n");

  try {
    const result = await getEmailClient().emails.send({
      from: env.ALERT_FROM_EMAIL!,
      subject,
      text,
      to: env.OWNER_ALERT_EMAIL!
    });

    if (result.error) {
      throw new Error(result.error.message || "Resend failed to send the owner alert email.");
    }

    await prisma.complimentRequest.update({
      where: { id: request.id },
      data: {
        ownerAlertSentAt: new Date()
      }
    });

    console.info("[Compliment Sandwich email] Owner alert sent.", {
      emailId: result.data?.id ?? null,
      requestId: request.id
    });

    return { sent: true as const, id: result.data?.id ?? null };
  } catch (error) {
    console.error("[Compliment Sandwich email] Failed to send owner alert.", error, {
      requestId: request.id
    });
    return { sent: false as const, reason: "send_failed" as const };
  }
}

export async function sendCustomerAccessEmail(input: {
  to: string;
  requestId: string;
  amountCents: number;
  accessUrl: string;
  isReadyNow: boolean;
  isFreeRequest: boolean;
  queuePriority: "paid" | "free";
}) {
  const env = getEmailEnv();

  if (!isCustomerEmailDeliveryConfigured()) {
    console.info("[Compliment Sandwich email] Skipping customer access email because free-email env vars are not configured.", {
      alertFromConfigured: Boolean(env.ALERT_FROM_EMAIL),
      requestId: input.requestId,
      resendConfigured: Boolean(env.RESEND_API_KEY)
    });
    return { sent: false as const, reason: "not_configured" as const };
  }

  const subject = input.isFreeRequest ? "Your free compliment link" : "Your compliment link";
  const intro = input.isReadyNow
    ? "Your compliment is ready. Open this link to join or resume the room."
    : "Your compliment request is in line. Open this link to check the line or join when it is your turn.";
  const amountLine = input.isFreeRequest
    ? "Price: free"
    : `Amount on hold: ${formatMoney(input.amountCents)}`;
  const priorityLine = input.queuePriority === "free"
    ? "Paid requests may have less wait."
    : "This request stays in the paid line.";

  const text = [
    intro,
    amountLine,
    `Request ID: ${input.requestId}`,
    priorityLine,
    `Access link: ${input.accessUrl}`
  ].join("\n");

  try {
    const result = await getEmailClient().emails.send({
      from: env.ALERT_FROM_EMAIL!,
      subject,
      text,
      to: input.to
    });

    if (result.error) {
      throw new Error(result.error.message || "Resend failed to send the customer access email.");
    }

    console.info("[Compliment Sandwich email] Customer access email sent.", {
      emailId: result.data?.id ?? null,
      requestId: input.requestId,
      to: input.to
    });

    return { sent: true as const, id: result.data?.id ?? null };
  } catch (error) {
    console.error("[Compliment Sandwich email] Failed to send customer access email.", error, {
      requestId: input.requestId,
      to: input.to
    });
    return { sent: false as const, reason: "send_failed" as const };
  }
}
