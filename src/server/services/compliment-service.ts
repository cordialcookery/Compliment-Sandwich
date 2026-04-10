import "server-only";

import { randomUUID } from "node:crypto";

import {
  CallAttemptStatus,
  ComplimentRequestStatus,
  ComplimentRequestType,
  GiftRedemptionStatus,
  PaymentAttemptStatus,
  PaymentMethodType,
  PaymentProvider,
  Prisma,
  RequestPriority
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { validatePaidAmountCents } from "@/src/lib/amount";
import { hashValue } from "@/src/lib/crypto";
import { getServerEnv } from "@/src/lib/env";
import { HttpError } from "@/src/lib/http";
import {
  buildCustomerJoinPath,
  buildQueueWaitPath,
  LIVE_SESSION_ACTIVE_STATUSES,
  LIVE_SESSION_CUSTOMER_ROLE,
  LIVE_SESSION_OWNER_ROLE,
  type LiveSessionRole
} from "@/src/lib/live-session";
import { maskPhoneNumber, normalizeUsPhone } from "@/src/lib/phone";
import { ensureBootstrapData } from "@/src/server/bootstrap";
import { createLiveAccessToken, createLiveRoom, completeLiveRoom } from "@/src/server/live/twilio-video";
import { paymentGateways } from "@/src/server/payments";
import {
  isCustomerEmailDeliveryConfigured,
  sendCustomerAccessEmail,
  sendOwnerNewRequestEmail
} from "@/src/server/alerts/resend-email";
import { assertCanAcceptComplimentRequests, getPublicAvailability } from "@/src/server/services/availability";
import { ACTIVE_REQUEST_STATUSES, MAX_WAITING_QUEUE_SIZE } from "@/src/lib/constants";

const ACTIVE_STATUS_VALUES = ACTIVE_REQUEST_STATUSES as unknown as ComplimentRequestStatus[];
const ACTIVE_LIVE_SESSION_VALUES = LIVE_SESSION_ACTIVE_STATUSES as unknown as Array<
  RequestWithAttempts["liveSession"] extends { status: infer T } ? T : never
>;
const QUEUE_ORDER_BY = [
  { queuePriority: "asc" as const },
  { queuedAt: "asc" as const },
  { createdAt: "asc" as const }
];

const BUSY_MESSAGE = "Sorry, the compliment kitchen is busy right now. Try again in a minute.";
const QUEUE_FULL_MESSAGE = "Sorry, the line is full right now.";
const QUEUE_WAITING_MESSAGE = "You're in line for a compliment.";
const QUEUE_EXPIRED_MESSAGE = "This request expired before the compliment could happen.";
const FREE_ALREADY_USED_MESSAGE = "That email already used its free compliment.";
const FREE_ALREADY_ACTIVE_MESSAGE = "That email already has a free compliment in progress.";
const FREE_BROWSER_ALREADY_USED_MESSAGE = "This browser already used its free compliment.";
const FREE_NOT_CONFIGURED_MESSAGE = "Free compliments are not configured right now.";

const requestInclude = {
  paymentAttempts: {
    orderBy: {
      createdAt: "desc" as const
    }
  },
  callAttempts: {
    orderBy: {
      createdAt: "desc" as const
    }
  },
  liveSession: true
};

type RequestWithAttempts = Prisma.ComplimentRequestGetPayload<{
  include: typeof requestInclude;
}>;

type QueueSnapshotState = "queued" | "promoting" | "ready" | "expired" | "canceled" | "completed";

type FreeRequestCreationResult = {
  request: RequestWithAttempts;
  accessToken: string;
  waitPath: string;
  emailSent: boolean;
};

type ServiceDependencies = {
  createRoom: typeof import("@/src/server/live/twilio-video").createLiveRoom;
  completeRoom: typeof import("@/src/server/live/twilio-video").completeLiveRoom;
  stripe: {
    capture: (paymentIntentId: string) => Promise<unknown>;
    cancel: (paymentIntentId: string) => Promise<unknown>;
  };
  paypal: {
    capture: (authorizationId: string) => Promise<unknown>;
    cancel: (authorizationId: string) => Promise<unknown>;
  };
  sendOwnerAlert: (input: { requestId: string; amountCents: number }) => Promise<unknown>;
  sendCustomerAccessEmail: (input: {
    to: string;
    requestId: string;
    amountCents: number;
    accessUrl: string;
    isReadyNow: boolean;
    isFreeRequest: boolean;
    queuePriority: "paid" | "free";
  }) => Promise<unknown>;
};

const defaultDependencies: ServiceDependencies = {
  createRoom: createLiveRoom,
  completeRoom: completeLiveRoom,
  stripe: paymentGateways.stripe,
  paypal: paymentGateways.paypal,
  sendOwnerAlert: sendOwnerNewRequestEmail,
  sendCustomerAccessEmail
};

function latestPayment(request: RequestWithAttempts) {
  return request.paymentAttempts[0] ?? null;
}

function latestCall(request: RequestWithAttempts) {
  return request.callAttempts[0] ?? null;
}

function getPaymentStatusLabel(request: RequestWithAttempts) {
  return latestPayment(request)?.status ?? (isFreeRequest(request) ? "not_required" : "requires_payment_method");
}

function getProviderTargetId(paymentAttempt: NonNullable<ReturnType<typeof latestPayment>>) {
  return paymentAttempt.provider === "paypal"
    ? paymentAttempt.authorizationId ?? paymentAttempt.externalPaymentId
    : paymentAttempt.externalPaymentId;
}

function extractErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Unexpected error";
}

function isRequestFinal(status: ComplimentRequestStatus) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isGiftRequest(request: Pick<RequestWithAttempts, "requestType"> | { requestType: ComplimentRequestType }) {
  return request.requestType === "gift_paid";
}

function isFreeRequest(request: Pick<RequestWithAttempts, "requestType"> | { requestType: ComplimentRequestType }) {
  return request.requestType === "self_free";
}

function normalizeCustomerEmail(email: string) {
  return email.trim().toLowerCase();
}

function createCustomerAccessToken() {
  return `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
}

function getParticipantRole(request: RequestWithAttempts, identity: string | null | undefined): LiveSessionRole | null {
  if (!identity || !request.liveSession) {
    return null;
  }

  if (identity === request.liveSession.ownerIdentity) {
    return LIVE_SESSION_OWNER_ROLE;
  }

  if (identity === request.liveSession.customerIdentity) {
    return LIVE_SESSION_CUSTOMER_ROLE;
  }

  return null;
}

function buildEligibleQueueWhere(now = new Date(), excludeRequestId?: string): Prisma.ComplimentRequestWhereInput {
  const clauses: Prisma.ComplimentRequestWhereInput[] = [
    { status: "queued" },
    {
      OR: [
        { queueExpiresAt: null },
        { queueExpiresAt: { gt: now } }
      ]
    }
  ];

  if (excludeRequestId) {
    clauses.push({ id: { not: excludeRequestId } });
  }

  return { AND: clauses };
}

async function getRequestOrThrow(requestId: string) {
  const request = await prisma.complimentRequest.findUnique({
    where: { id: requestId },
    include: requestInclude
  });

  if (!request) {
    throw new HttpError(404, "Compliment request not found.");
  }

  return request;
}

async function getRequestByClientRequestId(clientRequestId: string) {
  return prisma.complimentRequest.findUnique({
    where: { clientRequestId },
    include: requestInclude
  });
}

async function getRequestByExternalPayment(provider: PaymentProvider, externalPaymentId: string) {
  const paymentAttempt = await prisma.paymentAttempt.findFirst({
    where: {
      provider,
      OR: [{ externalPaymentId }, { authorizationId: externalPaymentId }]
    },
    orderBy: {
      createdAt: "desc"
    }
  });

  if (!paymentAttempt) {
    return null;
  }

  return getRequestOrThrow(paymentAttempt.complimentRequestId);
}

async function getRequestByGiftToken(giftToken: string) {
  return prisma.complimentRequest.findFirst({
    where: { giftToken },
    include: requestInclude
  });
}

export function createComplimentService(overrides: Partial<ServiceDependencies> = {}) {
  const dependencies: ServiceDependencies = {
    ...defaultDependencies,
    ...overrides,
    createRoom: overrides.createRoom ?? createLiveRoom,
    completeRoom: overrides.completeRoom ?? completeLiveRoom,
    stripe: {
      ...defaultDependencies.stripe,
      ...overrides.stripe
    },
    paypal: {
      ...defaultDependencies.paypal,
      ...overrides.paypal
    },
    sendCustomerAccessEmail: overrides.sendCustomerAccessEmail ?? sendCustomerAccessEmail
  };

  async function lockServiceState(tx: Prisma.TransactionClient) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ServiceAvailability" WHERE "id" = 1 FOR UPDATE`);
  }

  function getQueueExpirationDate(reference = new Date()) {
    const env = getServerEnv();
    return new Date(reference.getTime() + env.QUEUE_REQUEST_EXPIRATION_MINUTES * 60 * 1000);
  }

  async function getQueuePositionTx(tx: Prisma.TransactionClient, requestId: string, now = new Date()) {
    const [activeRequest, queuedIds] = await Promise.all([
      tx.complimentRequest.findFirst({
        where: {
          status: { in: ACTIVE_STATUS_VALUES }
        },
        select: { id: true }
      }),
      tx.complimentRequest.findMany({
        where: buildEligibleQueueWhere(now),
        orderBy: QUEUE_ORDER_BY,
        select: { id: true }
      })
    ]);

    const index = queuedIds.findIndex((entry) => entry.id === requestId);
    return index >= 0 ? index + (activeRequest ? 2 : 1) : null;
  }

  function canStartAheadOfQueuedRequest(
    current: Pick<RequestWithAttempts, "status" | "queuePriority">,
    nextQueuedRequest: { id: string; queuePriority: RequestPriority } | null,
    requestId: string
  ) {
    if (!nextQueuedRequest) {
      return true;
    }

    if (current.status === "queued") {
      return nextQueuedRequest.id === requestId;
    }

    if (current.queuePriority === "paid") {
      return nextQueuedRequest.queuePriority === "free";
    }

    return false;
  }

  async function releaseExternalAuthorization(input: {
    provider: PaymentProvider;
    externalPaymentId: string;
    authorizationId?: string | null;
  }) {
    const providerTargetId = input.provider === "paypal"
      ? input.authorizationId ?? input.externalPaymentId
      : input.externalPaymentId;

    if (!providerTargetId) {
      return;
    }

    if (input.provider === "stripe") {
      await dependencies.stripe.cancel(providerTargetId);
      return;
    }

    await dependencies.paypal.cancel(providerTargetId);
  }

  async function closeRoom(roomName?: string | null) {
    if (!roomName) {
      return;
    }

    await dependencies.completeRoom(roomName);
  }

  async function sendOwnerAlertSafely(request: RequestWithAttempts) {
    try {
      await dependencies.sendOwnerAlert({
        requestId: request.id,
        amountCents: request.amountCents
      });
    } catch (error) {
      console.error("[Compliment Sandwich alerts] Owner alert dependency failed.", error, {
        requestId: request.id
      });
    }
  }

  async function sendCustomerAccessEmailSafely(request: RequestWithAttempts, rawAccessToken: string) {
    if (!request.customerEmail) {
      return {
        sent: false as const,
        waitPath: buildQueueWaitPath(request.id, rawAccessToken, "accessToken")
      };
    }

    const env = getServerEnv();
    const waitPath = buildQueueWaitPath(request.id, rawAccessToken, "accessToken");
    const accessUrl = new URL(waitPath, env.APP_URL).toString();
    const result = await dependencies.sendCustomerAccessEmail({
      to: request.customerEmail,
      requestId: request.id,
      amountCents: request.amountCents,
      accessUrl,
      isReadyNow: Boolean(request.liveSession && ACTIVE_LIVE_SESSION_VALUES.includes(request.liveSession.status as never)),
      isFreeRequest: isFreeRequest(request),
      queuePriority: request.queuePriority
    });

    if ((result as { sent?: boolean }).sent) {
      await prisma.complimentRequest.update({
        where: { id: request.id },
        data: {
          customerAccessEmailSentAt: new Date()
        }
      });
    }

    return {
      sent: Boolean((result as { sent?: boolean }).sent),
      waitPath
    };
  }

  async function restoreGiftLink(
    requestId: string,
    reason: string,
    nextCallStatus: CallAttemptStatus = "failed",
    nextLiveStatus: "disconnected" | "failed" = "failed"
  ) {
    const request = await getRequestOrThrow(requestId);
    const callAttempt = latestCall(request);
    const liveSession = request.liveSession;

    await prisma.$transaction(async (tx) => {
      if (callAttempt) {
        await tx.callAttempt.update({
          where: { id: callAttempt.id },
          data: {
            status: nextCallStatus,
            failureReason: reason,
            completedAt: new Date()
          }
        });
      }

      if (liveSession) {
        await tx.liveSession.update({
          where: { id: liveSession.id },
          data: {
            status: nextLiveStatus,
            endedReason: reason,
            disconnectedAt: new Date(),
            ownerConnected: false,
            customerConnected: false,
            ownerLeftAt: liveSession.ownerConnected ? new Date() : liveSession.ownerLeftAt,
            customerLeftAt: liveSession.customerConnected ? new Date() : liveSession.customerLeftAt
          }
        });
      }

      await tx.complimentRequest.update({
        where: { id: request.id },
        data: {
          status: "payment_authorized",
          failureReason: reason,
          answeredAt: null,
          failedAt: null,
          canceledAt: null,
          activatedAt: null,
          queuedAt: null,
          queueExpiresAt: null,
          giftRedemptionStatus: reason.includes("Not available right now") ? "attempted_while_unavailable" : "link_ready",
          giftLastUnavailableAt: reason.includes("Not available right now") ? new Date() : request.giftLastUnavailableAt,
          ownerAlertSentAt: null
        }
      });
    });

    await closeRoom(liveSession?.roomName);
    await maybePromoteNextQueuedRequest();
    return getRequestOrThrow(request.id);
  }

  async function startLiveAttempt(input: {
    requestId: string;
    customerRequestedVideo?: boolean | null;
    onFailure: "cancel_authorization" | "preserve_gift" | "cancel_free";
  }) {
    await ensureBootstrapData();
    const request = await prisma.$transaction(async (tx) => {
      await lockServiceState(tx);
      const now = new Date();
      const current = await tx.complimentRequest.findUnique({
        where: { id: input.requestId },
        include: requestInclude
      });

      if (!current) {
        throw new HttpError(404, "Compliment request not found.");
      }
      if (current.status === "completed") {
        return current;
      }
      if (current.status === "failed" || current.status === "canceled") {
        throw new HttpError(409, "This compliment request is no longer active.");
      }

      const paymentAttempt = latestPayment(current);
      if (!isFreeRequest(current) && (!paymentAttempt || paymentAttempt.status !== "authorized")) {
        throw new HttpError(409, "There is no live authorization ready for this compliment request.");
      }

      if (
        current.liveSession &&
        ACTIVE_LIVE_SESSION_VALUES.includes(current.liveSession.status as never) &&
        ACTIVE_STATUS_VALUES.includes(current.status as never)
      ) {
        return current;
      }

      const availability = await tx.serviceAvailability.findUnique({ where: { id: 1 } });
      if (availability && !availability.isAvailable) {
        throw new HttpError(409, availability.ownerMessage || "The compliment kitchen is closed right now.");
      }

      const requestedVideo = input.customerRequestedVideo ?? current.customerRequestedVideo;
      const otherActiveRequest = await tx.complimentRequest.findFirst({
        where: {
          id: { not: current.id },
          status: { in: ACTIVE_STATUS_VALUES }
        },
        select: { id: true }
      });

      if (otherActiveRequest) {
        throw new HttpError(409, BUSY_MESSAGE);
      }

      const nextQueuedRequest = await tx.complimentRequest.findFirst({
        where: buildEligibleQueueWhere(now),
        orderBy: QUEUE_ORDER_BY,
        select: {
          id: true,
          queuePriority: true
        }
      });

      if (!canStartAheadOfQueuedRequest(current, nextQueuedRequest, current.id)) {
        throw new HttpError(409, BUSY_MESSAGE);
      }

      return tx.complimentRequest.update({
        where: { id: current.id },
        data: {
          status: "calling",
          failureReason: null,
          answeredAt: null,
          failedAt: null,
          canceledAt: null,
          customerRequestedVideo: requestedVideo,
          activatedAt: current.activatedAt ?? now,
          queueExpiresAt: null,
          giftRedemptionStatus: isGiftRequest(current) ? "redeeming" : current.giftRedemptionStatus
        },
        include: requestInclude
      });
    });

    if (
      request.liveSession &&
      ACTIVE_LIVE_SESSION_VALUES.includes(request.liveSession.status as never) &&
      ACTIVE_STATUS_VALUES.includes(request.status as never)
    ) {
      return request;
    }

    try {
      const room = await dependencies.createRoom({ requestId: request.id });
      const env = getServerEnv();
      const liveSessionData = {
        roomName: room.roomName,
        roomSid: room.roomSid,
        customerJoinKey: randomUUID(),
        ownerIdentity: request.liveSession?.ownerIdentity ?? `owner-${request.id}`,
        customerIdentity: request.liveSession?.customerIdentity ?? `customer-${request.id}`,
        status: "waiting_for_owner" as const,
        customerRequestedVideo: request.customerRequestedVideo,
        customerVideoEnabled: request.customerRequestedVideo,
        customerAudioEnabled: true,
        customerAudioMuted: false,
        ownerConnected: false,
        customerConnected: false,
        ownerVideoEnabled: true,
        ownerAudioEnabled: true,
        ownerJoinedAt: null,
        customerJoinedAt: null,
        ownerLeftAt: null,
        customerLeftAt: null,
        joinedAt: null,
        disconnectedAt: null,
        completedAt: null,
        endedReason: null,
        ownerJoinDeadlineAt: new Date(Date.now() + env.LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS * 1000)
      };

      if (request.liveSession) {
        await prisma.liveSession.update({
          where: { id: request.liveSession.id },
          data: liveSessionData
        });
      } else {
        await prisma.liveSession.create({
          data: {
            complimentRequestId: request.id,
            ...liveSessionData
          }
        });
      }

      await prisma.callAttempt.create({
        data: {
          complimentRequestId: request.id,
          status: "initiated",
          direction: "browser",
          roomName: room.roomName
        }
      });

      const activeRequest = await getRequestOrThrow(request.id);
      await sendOwnerAlertSafely(activeRequest);
      return activeRequest;
    } catch (error) {
      if (input.onFailure === "preserve_gift") {
        await restoreGiftLink(
          request.id,
          `The live compliment room could not be created, so the gift link is still usable. ${extractErrorMessage(error)}`,
          "failed",
          "failed"
        );
        throw new HttpError(502, "The live compliment room could not be created. The gift link still works, so please try again later.");
      }

      await cancelAuthorizedPaymentForRequest(
        request.id,
        input.onFailure === "cancel_free"
          ? `The live compliment room could not be created, so the free request was canceled. ${extractErrorMessage(error)}`
          : `The live compliment room could not be created, so no charge was made. ${extractErrorMessage(error)}`,
        "failed",
        "failed"
      );
      throw new HttpError(
        502,
        input.onFailure === "cancel_free"
          ? "The live compliment room could not be created, so the free request was canceled."
          : "The live compliment room could not be created, so no charge was made."
      );
    }
  }

  async function releaseAuthorizedRequestAfterAdmissionFailure(input: {
    requestId: string;
    provider: PaymentProvider;
    externalPaymentId: string;
    authorizationId?: string | null;
    paymentMethodType: PaymentMethodType;
    idempotencyKey: string;
    reason: string;
  }) {
    let nextPaymentStatus: PaymentAttemptStatus = "canceled";
    let paymentFailureReason: string | null = null;

    try {
      await releaseExternalAuthorization(input);
    } catch (error) {
      nextPaymentStatus = "failed";
      paymentFailureReason = `${input.reason} ${extractErrorMessage(error)}`;
    }

    await prisma.$transaction(async (tx) => {
      const existingPayment = await tx.paymentAttempt.findFirst({
        where: { complimentRequestId: input.requestId },
        orderBy: { createdAt: "desc" }
      });

      if (existingPayment) {
        await tx.paymentAttempt.update({
          where: { id: existingPayment.id },
          data: {
            provider: input.provider,
            methodType: input.paymentMethodType,
            externalPaymentId: input.externalPaymentId,
            authorizationId: input.authorizationId ?? input.externalPaymentId,
            idempotencyKey: input.idempotencyKey,
            status: nextPaymentStatus,
            failureReason:
              paymentFailureReason ??
              (nextPaymentStatus === "canceled" ? input.reason : existingPayment.failureReason),
            canceledAt: nextPaymentStatus === "canceled" ? new Date() : existingPayment.canceledAt
          }
        });
      }

      await tx.complimentRequest.update({
        where: { id: input.requestId },
        data: {
          status: "failed",
          failureReason: paymentFailureReason ?? input.reason,
          failedAt: new Date()
        }
      });
    });
  }

  async function queueRequest(input: {
    requestId: string;
    customerRequestedVideo: boolean;
  }) {
    await expireQueuedRequests();
    return prisma.$transaction(async (tx) => {
      await lockServiceState(tx);
      const now = new Date();
      const current = await tx.complimentRequest.findUnique({
        where: { id: input.requestId },
        include: requestInclude
      });

      if (!current) {
        throw new HttpError(404, "Compliment request not found.");
      }
      if (current.status === "completed") {
        return { request: current, position: null };
      }
      if (current.status === "failed" || current.status === "canceled") {
        throw new HttpError(409, "This compliment request is no longer active.");
      }

      const paymentAttempt = latestPayment(current);
      if (!isFreeRequest(current) && (!paymentAttempt || paymentAttempt.status !== "authorized")) {
        throw new HttpError(409, "There is no live authorization ready for this compliment request.");
      }

      if (current.status === "queued" && (!current.queueExpiresAt || current.queueExpiresAt.getTime() > now.getTime())) {
        return {
          request: current,
          position: await getQueuePositionTx(tx, current.id, now)
        };
      }

      const availability = await tx.serviceAvailability.findUnique({ where: { id: 1 } });
      if (availability && !availability.isAvailable) {
        throw new HttpError(409, availability.ownerMessage || "The compliment kitchen is closed right now.");
      }

      const queuedCount = await tx.complimentRequest.count({
        where: buildEligibleQueueWhere(now, current.id)
      });

      if (queuedCount >= MAX_WAITING_QUEUE_SIZE) {
        throw new HttpError(409, QUEUE_FULL_MESSAGE);
      }

      const updated = await tx.complimentRequest.update({
        where: { id: current.id },
        data: {
          status: "queued",
          queuedAt: current.queuedAt ?? now,
          activatedAt: null,
          queueExpiresAt: isGiftRequest(current)
            ? null
            : current.queueExpiresAt && current.queueExpiresAt.getTime() > now.getTime()
              ? current.queueExpiresAt
              : getQueueExpirationDate(now),
          customerRequestedVideo: input.customerRequestedVideo,
          failureReason: QUEUE_WAITING_MESSAGE,
          failedAt: null,
          canceledAt: null,
          answeredAt: null,
          giftRedemptionStatus: isGiftRequest(current) ? "redeeming" : current.giftRedemptionStatus
        },
        include: requestInclude
      });

      return {
        request: updated,
        position: await getQueuePositionTx(tx, updated.id, now)
      };
    });
  }

  async function cancelAuthorizedPaymentForRequest(
    requestId: string,
    reason: string,
    nextCallStatus: CallAttemptStatus = "failed",
    nextLiveStatus: "disconnected" | "failed" = "failed",
    options?: {
      nextRequestStatus?: "failed" | "canceled";
      skipPromotion?: boolean;
    }
  ) {
    const request = await getRequestOrThrow(requestId);
    const paymentAttempt = latestPayment(request);
    const callAttempt = latestCall(request);
    const liveSession = request.liveSession;
    const nextRequestStatus = options?.nextRequestStatus ?? "failed";

    if (request.status === "completed") {
      return request;
    }

    let nextPaymentStatus: PaymentAttemptStatus | null = paymentAttempt?.status ?? null;
    let paymentFailureReason: string | null = null;

    if (paymentAttempt && paymentAttempt.status === "authorized") {
      const targetId = getProviderTargetId(paymentAttempt);
      if (!targetId) {
        nextPaymentStatus = "failed";
        paymentFailureReason = `${reason} Authorization target id was missing.`;
      } else {
        try {
          await releaseExternalAuthorization({
            provider: paymentAttempt.provider,
            externalPaymentId: paymentAttempt.externalPaymentId ?? targetId,
            authorizationId: paymentAttempt.authorizationId
          });
          nextPaymentStatus = "canceled";
        } catch (error) {
          nextPaymentStatus = "failed";
          paymentFailureReason = `${reason} ${extractErrorMessage(error)}`;
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      if (paymentAttempt) {
        await tx.paymentAttempt.update({
          where: { id: paymentAttempt.id },
          data: {
            status: nextPaymentStatus ?? paymentAttempt.status,
            failureReason:
              paymentFailureReason ??
              (nextPaymentStatus === "canceled" ? reason : paymentAttempt.failureReason),
            canceledAt: nextPaymentStatus === "canceled" ? new Date() : paymentAttempt.canceledAt
          }
        });
      }

      if (callAttempt) {
        await tx.callAttempt.update({
          where: { id: callAttempt.id },
          data: {
            status: nextCallStatus,
            failureReason: reason,
            completedAt: new Date()
          }
        });
      }

      if (liveSession) {
        await tx.liveSession.update({
          where: { id: liveSession.id },
          data: {
            status: nextLiveStatus,
            endedReason: reason,
            disconnectedAt: new Date()
          }
        });
      }

      await tx.complimentRequest.update({
        where: { id: requestId },
        data: {
          status: nextRequestStatus,
          failureReason: paymentFailureReason ?? reason,
          failedAt: nextRequestStatus === "failed" ? new Date() : null,
          canceledAt: nextRequestStatus === "canceled" ? new Date() : null,
          queuedAt: null,
          activatedAt: null,
          queueExpiresAt: null,
          giftRedemptionStatus: isGiftRequest(request) ? "canceled" : request.giftRedemptionStatus,
          ownerAlertSentAt: isGiftRequest(request) ? null : request.ownerAlertSentAt
        }
      });
    });

    await closeRoom(liveSession?.roomName);
    if (!options?.skipPromotion) {
      await maybePromoteNextQueuedRequest();
    }
    return getRequestOrThrow(requestId);
  }

  async function expireQueuedRequestIfNeeded(requestId: string) {
    const request = await getRequestOrThrow(requestId);
    if (
      request.status !== "queued" ||
      !request.queueExpiresAt ||
      request.queueExpiresAt.getTime() > Date.now()
    ) {
      return request;
    }

    return cancelAuthorizedPaymentForRequest(
      request.id,
      QUEUE_EXPIRED_MESSAGE,
      "failed",
      "failed",
      {
        nextRequestStatus: "canceled",
        skipPromotion: true
      }
    );
  }

  async function expireQueuedRequests() {
    const now = new Date();
    const expiredRequests = await prisma.complimentRequest.findMany({
      where: {
        status: "queued",
        queueExpiresAt: {
          lte: now
        }
      },
      select: {
        id: true
      }
    });

    for (const expiredRequest of expiredRequests) {
      await cancelAuthorizedPaymentForRequest(
        expiredRequest.id,
        QUEUE_EXPIRED_MESSAGE,
        "failed",
        "failed",
        {
          nextRequestStatus: "canceled",
          skipPromotion: true
        }
      );
    }
  }

  async function promoteNextQueuedRequest() {
    await ensureBootstrapData();
    await expireQueuedRequests();

    for (let attemptIndex = 0; attemptIndex < MAX_WAITING_QUEUE_SIZE; attemptIndex += 1) {
      const candidate = await prisma.$transaction(async (tx) => {
        await lockServiceState(tx);
        const availability = await tx.serviceAvailability.findUnique({ where: { id: 1 } });
        if (availability && !availability.isAvailable) {
          return null;
        }

        const activeRequest = await tx.complimentRequest.findFirst({
          where: {
            status: {
              in: ACTIVE_STATUS_VALUES
            }
          },
          orderBy: {
            createdAt: "asc"
          }
        });

        if (activeRequest) {
          return null;
        }

        return tx.complimentRequest.findFirst({
          where: buildEligibleQueueWhere(new Date()),
          orderBy: QUEUE_ORDER_BY,
          include: requestInclude
        });
      });

      if (!candidate) {
        return null;
      }

      try {
        return await startLiveAttempt({
          requestId: candidate.id,
          customerRequestedVideo: candidate.customerRequestedVideo,
          onFailure: isGiftRequest(candidate)
            ? "preserve_gift"
            : isFreeRequest(candidate)
              ? "cancel_free"
              : "cancel_authorization"
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409 && error.message === BUSY_MESSAGE) {
          return null;
        }

        console.error("[Compliment Sandwich queue] Failed to promote queued request.", error, {
          requestId: candidate.id
        });
      }
    }

    return null;
  }

  async function maybePromoteNextQueuedRequest() {
    try {
      await promoteNextQueuedRequest();
    } catch (error) {
      console.error("[Compliment Sandwich queue] Promotion check failed.", error);
    }
  }

  async function evaluateNoShowTimeout(requestId: string) {
    const request = await getRequestOrThrow(requestId);
    const liveSession = request.liveSession;

    if (!liveSession || isRequestFinal(request.status)) {
      return request;
    }

    if (
      liveSession.status === "waiting_for_owner" &&
      liveSession.ownerJoinDeadlineAt &&
      liveSession.ownerJoinDeadlineAt.getTime() <= Date.now()
    ) {
      if (isGiftRequest(request)) {
        return restoreGiftLink(
          request.id,
          "Not available right now, try again later. The gift link still works.",
          "no_answer",
          "failed"
        );
      }

      return cancelAuthorizedPaymentForRequest(
        request.id,
        isFreeRequest(request)
          ? "The owner never joined the live compliment room in time, so the free request was closed."
          : "The owner never joined the live compliment room in time, so no charge was made.",
        "no_answer",
        "failed"
      );
    }

    return request;
  }

  return {
    async createPendingRequest(input: {
      clientRequestId: string;
      amountCents: number;
      customerPhoneRaw?: string | null;
      provider: PaymentProvider;
      paymentMethodType: PaymentMethodType;
      requestType: ComplimentRequestType;
    }): Promise<RequestWithAttempts> {
      validatePaidAmountCents(input.amountCents);
      await ensureBootstrapData();
      if (input.requestType === "self_paid") {
        await assertCanAcceptComplimentRequests();
      }

      const normalizedPhone = input.customerPhoneRaw?.trim() ? normalizeUsPhone(input.customerPhoneRaw) : null;
      const existing = await getRequestByClientRequestId(input.clientRequestId);
      if (existing) {
        return existing;
      }

      try {
        return await prisma.complimentRequest.create({
          data: {
            clientRequestId: input.clientRequestId,
            amountCents: input.amountCents,
            customerPhoneE164: normalizedPhone,
            customerPhoneMasked: normalizedPhone ? maskPhoneNumber(normalizedPhone) : null,
            provider: input.provider,
            paymentMethodType: input.paymentMethodType,
            requestType: input.requestType,
            queuePriority: "paid",
            status: "pending",
            paymentAttempts: {
              create: {
                provider: input.provider,
                methodType: input.paymentMethodType,
                amountCents: input.amountCents,
                status: "requires_payment_method",
                idempotencyKey: `request-${input.clientRequestId}`
              }
            }
          },
          include: requestInclude
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const duplicate = await getRequestByClientRequestId(input.clientRequestId);
          if (duplicate) {
            return duplicate;
          }
        }

        throw error;
      }
    },

    async createFreeRequest(input: {
      clientRequestId: string;
      email: string;
      customerRequestedVideo: boolean;
      actor: string;
      browserMarker?: string | null;
      userAgent?: string | null;
    }): Promise<FreeRequestCreationResult> {
      await ensureBootstrapData();
      await assertCanAcceptComplimentRequests();

      if (!isCustomerEmailDeliveryConfigured()) {
        throw new HttpError(503, FREE_NOT_CONFIGURED_MESSAGE);
      }

      const normalizedEmail = normalizeCustomerEmail(input.email);
      const existing = await getRequestByClientRequestId(input.clientRequestId);
      if (existing) {
        throw new HttpError(409, "This free compliment request already exists. Check your email or your open tab for the access link.");
      }

      const requesterIpHash = hashValue(input.actor);
      const browserMarkerHash = input.browserMarker?.trim() ? hashValue(input.browserMarker.trim()) : null;
      const userAgentHash = input.userAgent?.trim() ? hashValue(input.userAgent.trim()) : null;
      const rawAccessToken = createCustomerAccessToken();
      const customerAccessTokenHash = hashValue(rawAccessToken);

      const request = await prisma.$transaction(async (tx) => {
        await lockServiceState(tx);

        const existingIdentity = await tx.freeComplimentIdentity.findUnique({
          where: { normalizedEmail }
        });

        if (existingIdentity?.consumedAt) {
          throw new HttpError(409, FREE_ALREADY_USED_MESSAGE);
        }

        const existingEmailRequest = await tx.complimentRequest.findFirst({
          where: {
            requestType: "self_free",
            customerEmailNormalized: normalizedEmail,
            status: {
              in: ["pending", "queued", "calling", "answered"]
            }
          },
          select: { id: true }
        });

        if (existingEmailRequest) {
          throw new HttpError(409, FREE_ALREADY_ACTIVE_MESSAGE);
        }

        if (browserMarkerHash) {
          const browserConsumed = await tx.complimentRequest.findFirst({
            where: {
              requestType: "self_free",
              browserMarkerHash,
              freeUseConsumedAt: {
                not: null
              }
            },
            select: { id: true }
          });

          if (browserConsumed) {
            throw new HttpError(409, FREE_BROWSER_ALREADY_USED_MESSAGE);
          }
        }

        const created = await tx.complimentRequest.create({
          data: {
            clientRequestId: input.clientRequestId,
            amountCents: 0,
            status: "pending",
            requestType: "self_free",
            queuePriority: "free",
            customerEmail: input.email.trim(),
            customerEmailNormalized: normalizedEmail,
            customerAccessTokenHash,
            customerAccessTokenIssuedAt: new Date(),
            customerRequestedVideo: input.customerRequestedVideo,
            requesterIpHash,
            browserMarkerHash,
            userAgentHash,
            paymentMethodType: "unknown"
          },
          include: requestInclude
        });

        await tx.freeComplimentIdentity.upsert({
          where: { normalizedEmail },
          update: {
            lastAttemptAt: new Date(),
            hashedIpLastSeen: requesterIpHash,
            browserMarkerHashLastSeen: browserMarkerHash,
            userAgentHashLastSeen: userAgentHash,
            firstRequestId: existingIdentity?.firstRequestId ?? created.id
          },
          create: {
            normalizedEmail,
            firstRequestId: created.id,
            lastAttemptAt: new Date(),
            hashedIpLastSeen: requesterIpHash,
            browserMarkerHashLastSeen: browserMarkerHash,
            userAgentHashLastSeen: userAgentHash
          }
        });

        return created;
      });

      let admittedRequest: RequestWithAttempts;
      try {
        admittedRequest = await startLiveAttempt({
          requestId: request.id,
          customerRequestedVideo: input.customerRequestedVideo,
          onFailure: "cancel_free"
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409 && error.message === BUSY_MESSAGE) {
          const queued = await queueRequest({
            requestId: request.id,
            customerRequestedVideo: input.customerRequestedVideo
          });
          admittedRequest = queued.request;
        } else {
          throw error;
        }
      }

      const emailResult = await sendCustomerAccessEmailSafely(admittedRequest, rawAccessToken);
      const refreshedRequest = await getRequestOrThrow(admittedRequest.id);

      return {
        request: refreshedRequest,
        accessToken: rawAccessToken,
        waitPath: emailResult.waitPath,
        emailSent: emailResult.sent
      };
    },

    async confirmAuthorizedPayment(input: {
      requestId: string;
      provider: PaymentProvider;
      paymentMethodType: PaymentMethodType;
      externalPaymentId: string;
      authorizationId?: string | null;
      idempotencyKey: string;
      customerRequestedVideo: boolean;
    }): Promise<RequestWithAttempts> {
      let request: RequestWithAttempts;

      request = await prisma.$transaction(async (tx) => {
        const current = await tx.complimentRequest.findUnique({
          where: { id: input.requestId },
          include: requestInclude
        });

        if (!current) {
          throw new HttpError(404, "Compliment request not found.");
        }
        if (isFreeRequest(current)) {
          throw new HttpError(409, "Free compliments do not use payment authorization.");
        }
        if (current.status === "completed") {
          return current;
        }
        if (current.status === "failed" || current.status === "canceled") {
          throw new HttpError(409, "This compliment request is no longer active.");
        }

        const paymentAttempt = latestPayment(current);
        const alreadyActive = Boolean(
          paymentAttempt?.status === "authorized" &&
          current.liveSession &&
          ACTIVE_LIVE_SESSION_VALUES.includes(current.liveSession.status as never) &&
          ACTIVE_STATUS_VALUES.includes(current.status as never)
        );
        const alreadyPreparedGift = isGiftRequest(current) && paymentAttempt?.status === "authorized" && Boolean(current.giftToken);
        const alreadyQueuedSelf = current.requestType === "self_paid" && paymentAttempt?.status === "authorized" && current.status === "queued";

        if (alreadyActive || alreadyPreparedGift || alreadyQueuedSelf) {
          return current;
        }

        if (paymentAttempt) {
          await tx.paymentAttempt.update({
            where: { id: paymentAttempt.id },
            data: {
              provider: input.provider,
              methodType: input.paymentMethodType,
              externalPaymentId: input.externalPaymentId,
              authorizationId: input.authorizationId ?? input.externalPaymentId,
              idempotencyKey: input.idempotencyKey,
              status: "authorized",
              authorizedAt: new Date(),
              failureReason: null
            }
          });
        } else {
          await tx.paymentAttempt.create({
            data: {
              complimentRequestId: current.id,
              provider: input.provider,
              methodType: input.paymentMethodType,
              amountCents: current.amountCents,
              externalPaymentId: input.externalPaymentId,
              authorizationId: input.authorizationId ?? input.externalPaymentId,
              idempotencyKey: input.idempotencyKey,
              status: "authorized",
              authorizedAt: new Date()
            }
          });
        }

        return tx.complimentRequest.update({
          where: { id: current.id },
          data: {
            status: "payment_authorized",
            provider: input.provider,
            paymentMethodType: input.paymentMethodType,
            failureReason: null,
            customerRequestedVideo: isGiftRequest(current) ? current.customerRequestedVideo : input.customerRequestedVideo,
            giftToken: isGiftRequest(current) ? current.giftToken ?? randomUUID() : current.giftToken,
            giftLinkIssuedAt: isGiftRequest(current) ? current.giftLinkIssuedAt ?? new Date() : current.giftLinkIssuedAt,
            giftRedemptionStatus: isGiftRequest(current) ? "link_ready" : current.giftRedemptionStatus
          },
          include: requestInclude
        });
      });

      if (isGiftRequest(request)) {
        return request;
      }

      await maybePromoteNextQueuedRequest();
      const availability = await getPublicAvailability();
      if (!availability.availableNow) {
        const reason = availability.reason || "Compliments are unavailable right now.";
        await releaseAuthorizedRequestAfterAdmissionFailure({
          requestId: request.id,
          provider: input.provider,
          externalPaymentId: input.externalPaymentId,
          authorizationId: input.authorizationId,
          paymentMethodType: input.paymentMethodType,
          idempotencyKey: input.idempotencyKey,
          reason
        });
        throw new HttpError(409, reason);
      }

      try {
        return await startLiveAttempt({
          requestId: request.id,
          customerRequestedVideo: input.customerRequestedVideo,
          onFailure: "cancel_authorization"
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409 && error.message === BUSY_MESSAGE) {
          try {
            const queued = await queueRequest({
              requestId: request.id,
              customerRequestedVideo: input.customerRequestedVideo
            });
            return queued.request;
          } catch (queueError) {
            if (queueError instanceof HttpError && queueError.status === 409) {
              await releaseAuthorizedRequestAfterAdmissionFailure({
                requestId: request.id,
                provider: input.provider,
                externalPaymentId: input.externalPaymentId,
                authorizationId: input.authorizationId,
                paymentMethodType: input.paymentMethodType,
                idempotencyKey: input.idempotencyKey,
                reason: queueError.message
              });
            }

            throw queueError;
          }
        }

        throw error;
      }
    },

    async getQueueSnapshot(input: {
      requestId: string;
      requestKey?: string | null;
      accessToken?: string | null;
    }) {
      await ensureBootstrapData();
      await maybePromoteNextQueuedRequest();
      let request = await expireQueuedRequestIfNeeded(input.requestId);

      const accessTokenHash = input.accessToken?.trim() ? hashValue(input.accessToken.trim()) : null;
      const accessIsValid = Boolean(
        accessTokenHash && request.customerAccessTokenHash && accessTokenHash === request.customerAccessTokenHash
      );
      const requestKeyIsValid = Boolean(input.requestKey && request.clientRequestId === input.requestKey);

      if (isFreeRequest(request)) {
        if (!accessIsValid) {
          throw new HttpError(401, "That emailed access link is not valid.");
        }
      } else if (!requestKeyIsValid || isGiftRequest(request)) {
        throw new HttpError(401, "That waiting-room link is not valid.");
      }

      if (
        request.liveSession &&
        ACTIVE_LIVE_SESSION_VALUES.includes(request.liveSession.status as never) &&
        ACTIVE_STATUS_VALUES.includes(request.status as never)
      ) {
        return {
          state: "ready" as QueueSnapshotState,
          message: "It is your turn. Opening the live compliment room.",
          requestId: request.id,
          amountCents: request.amountCents,
          requestStatus: request.status,
          requestType: request.requestType,
          queuePriority: request.queuePriority,
          paymentStatus: getPaymentStatusLabel(request),
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: buildCustomerJoinPath(request.id, request.liveSession.customerJoinKey)
        };
      }

      if (request.status === "calling" && !request.liveSession) {
        return {
          state: "promoting" as QueueSnapshotState,
          message: "You are up next. Building the room now.",
          requestId: request.id,
          amountCents: request.amountCents,
          requestStatus: request.status,
          requestType: request.requestType,
          queuePriority: request.queuePriority,
          paymentStatus: getPaymentStatusLabel(request),
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null
        };
      }

      if (request.status === "completed") {
        return {
          state: "completed" as QueueSnapshotState,
          message: isFreeRequest(request) ? "This free compliment already happened." : "This compliment already happened.",
          requestId: request.id,
          amountCents: request.amountCents,
          requestStatus: request.status,
          requestType: request.requestType,
          queuePriority: request.queuePriority,
          paymentStatus: getPaymentStatusLabel(request),
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null
        };
      }

      if (request.status === "failed" || request.status === "canceled") {
        return {
          state: (request.failureReason === QUEUE_EXPIRED_MESSAGE ? "expired" : "canceled") as QueueSnapshotState,
          message: request.failureReason || "This request is no longer active.",
          requestId: request.id,
          amountCents: request.amountCents,
          requestStatus: request.status,
          requestType: request.requestType,
          queuePriority: request.queuePriority,
          paymentStatus: getPaymentStatusLabel(request),
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null
        };
      }

      request = await getRequestOrThrow(input.requestId);
      const availability = await getPublicAvailability();
      const queue = await prisma.complimentRequest.findMany({
        where: buildEligibleQueueWhere(new Date()),
        orderBy: QUEUE_ORDER_BY,
        select: {
          id: true
        }
      });
      const activeRequest = await prisma.complimentRequest.findFirst({
        where: {
          status: {
            in: ACTIVE_STATUS_VALUES
          }
        },
        select: { id: true }
      });
      const position = queue.findIndex((entry) => entry.id === request.id);

      return {
        state: "queued" as QueueSnapshotState,
        message: isFreeRequest(request)
          ? availability.availableNow
            ? "You're still in line. Paid requests may have less wait."
            : availability.reason || "Not available right now, but your free request is still waiting."
          : availability.availableNow || availability.reason === QUEUE_FULL_MESSAGE
            ? "The room will open when it is your turn."
            : availability.reason || "Not available right now, but you are still in line.",
        requestId: request.id,
        amountCents: request.amountCents,
        requestStatus: request.status,
        requestType: request.requestType,
        queuePriority: request.queuePriority,
        paymentStatus: getPaymentStatusLabel(request),
        position: position >= 0 ? position + (activeRequest ? 2 : 1) : null,
        queueCount: queue.length,
        queueMax: MAX_WAITING_QUEUE_SIZE,
        joinPath: null
      };
    },

    async getGiftSnapshot(giftToken: string) {
      await ensureBootstrapData();
      await maybePromoteNextQueuedRequest();
      const request = await getRequestByGiftToken(giftToken);

      if (!request || !isGiftRequest(request)) {
        return {
          state: "invalid",
          message: "That compliment gift link is not valid anymore.",
          amountCents: null,
          requestId: null,
          requestStatus: null,
          paymentStatus: null,
          giftRedemptionStatus: null,
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null,
          canRedeem: false
        };
      }

      const paymentStatus = getPaymentStatusLabel(request);
      const joinPath = request.liveSession ? buildCustomerJoinPath(request.id, request.liveSession.customerJoinKey) : null;

      if (request.status === "completed" || request.giftRedemptionStatus === "redeemed") {
        return {
          state: "used",
          message: "This compliment gift was already used.",
          amountCents: request.amountCents,
          requestId: request.id,
          requestStatus: request.status,
          paymentStatus,
          giftRedemptionStatus: request.giftRedemptionStatus,
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null,
          canRedeem: false
        };
      }

      if (request.status === "failed" || request.status === "canceled" || paymentStatus !== "authorized") {
        return {
          state: "canceled",
          message: request.failureReason || "This compliment gift is no longer active.",
          amountCents: request.amountCents,
          requestId: request.id,
          requestStatus: request.status,
          paymentStatus,
          giftRedemptionStatus: request.giftRedemptionStatus,
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null,
          canRedeem: false
        };
      }

      if (
        request.liveSession &&
        ACTIVE_LIVE_SESSION_VALUES.includes(request.liveSession.status as never) &&
        ACTIVE_STATUS_VALUES.includes(request.status as never)
      ) {
        return {
          state: "in_progress",
          message: "This compliment is already being redeemed. Continue to the live room.",
          amountCents: request.amountCents,
          requestId: request.id,
          requestStatus: request.status,
          paymentStatus,
          giftRedemptionStatus: request.giftRedemptionStatus,
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath,
          canRedeem: true
        };
      }

      if (request.status === "calling" && !request.liveSession) {
        return {
          state: "promoting",
          message: "You are up next. Building the room now.",
          amountCents: request.amountCents,
          requestId: request.id,
          requestStatus: request.status,
          paymentStatus,
          giftRedemptionStatus: request.giftRedemptionStatus,
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null,
          canRedeem: false
        };
      }

      if (request.status === "queued") {
        const queue = await prisma.complimentRequest.findMany({
          where: buildEligibleQueueWhere(new Date()),
          orderBy: QUEUE_ORDER_BY,
          select: { id: true }
        });
        const activeRequest = await prisma.complimentRequest.findFirst({
          where: { status: { in: ACTIVE_STATUS_VALUES } },
          select: { id: true }
        });
        const position = queue.findIndex((entry) => entry.id === request.id);

        return {
          state: "queued",
          message: "This gifted compliment is in the paid line. It will open when it is your turn.",
          amountCents: request.amountCents,
          requestId: request.id,
          requestStatus: request.status,
          paymentStatus,
          giftRedemptionStatus: request.giftRedemptionStatus,
          position: position >= 0 ? position + (activeRequest ? 2 : 1) : null,
          queueCount: queue.length,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null,
          canRedeem: false
        };
      }

      const availability = await getPublicAvailability();
      if (!availability.availableNow) {
        return {
          state: "unavailable",
          message: availability.reason || request.failureReason || "Not available right now, try again later.",
          amountCents: request.amountCents,
          requestId: request.id,
          requestStatus: request.status,
          paymentStatus,
          giftRedemptionStatus: request.giftRedemptionStatus,
          position: null,
          queueCount: 0,
          queueMax: MAX_WAITING_QUEUE_SIZE,
          joinPath: null,
          canRedeem: false
        };
      }

      return {
        state: "ready",
        message: "This compliment is ready whenever you are.",
        amountCents: request.amountCents,
        requestId: request.id,
        requestStatus: request.status,
        paymentStatus,
        giftRedemptionStatus: request.giftRedemptionStatus,
        position: null,
        queueCount: 0,
        queueMax: MAX_WAITING_QUEUE_SIZE,
        joinPath: null,
        canRedeem: true
      };
    },

    async redeemGift(input: {
      giftToken: string;
      customerRequestedVideo: boolean;
    }): Promise<RequestWithAttempts> {
      const request = await getRequestByGiftToken(input.giftToken);

      if (!request || !isGiftRequest(request)) {
        throw new HttpError(404, "That compliment gift link is not valid anymore.");
      }

      const paymentAttempt = latestPayment(request);
      if (request.status === "completed" || request.giftRedemptionStatus === "redeemed") {
        throw new HttpError(409, "This compliment gift was already used.");
      }
      if (!paymentAttempt || paymentAttempt.status !== "authorized") {
        throw new HttpError(409, "This compliment gift is no longer active.");
      }

      if (
        request.liveSession &&
        ACTIVE_LIVE_SESSION_VALUES.includes(request.liveSession.status as never) &&
        ACTIVE_STATUS_VALUES.includes(request.status as never)
      ) {
        return request;
      }

      if (request.status === "queued") {
        return request;
      }

      const availability = await getPublicAvailability();
      if (!availability.availableNow) {
        await prisma.complimentRequest.update({
          where: { id: request.id },
          data: {
            failureReason: availability.reason || "Not available right now, try again later.",
            giftRedemptionStatus: "attempted_while_unavailable",
            giftLastUnavailableAt: new Date()
          }
        });
        throw new HttpError(409, availability.reason || "Not available right now, try again later.");
      }

      try {
        return await startLiveAttempt({
          requestId: request.id,
          customerRequestedVideo: input.customerRequestedVideo,
          onFailure: "preserve_gift"
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409 && error.message === BUSY_MESSAGE) {
          const queued = await queueRequest({
            requestId: request.id,
            customerRequestedVideo: input.customerRequestedVideo
          });
          return queued.request;
        }

        throw error;
      }
    },

    async createLiveSessionToken(input: {
      requestId: string;
      role: LiveSessionRole;
      joinKey?: string | null;
    }) {
      const request = await evaluateNoShowTimeout(input.requestId);
      const liveSession = request.liveSession;

      if (!liveSession) {
        throw new HttpError(404, "Live session not found.");
      }

      if (isRequestFinal(request.status) || !ACTIVE_LIVE_SESSION_VALUES.includes(liveSession.status as never)) {
        throw new HttpError(409, "This live compliment session is no longer active.");
      }

      if (input.role === LIVE_SESSION_CUSTOMER_ROLE && input.joinKey !== liveSession.customerJoinKey) {
        throw new HttpError(401, "That customer join link is not valid.");
      }

      const identity = input.role === LIVE_SESSION_OWNER_ROLE ? liveSession.ownerIdentity : liveSession.customerIdentity;
      return {
        token: createLiveAccessToken({
          identity,
          roomName: liveSession.roomName
        }),
        roomName: liveSession.roomName,
        identity,
        joinPath: buildCustomerJoinPath(request.id, liveSession.customerJoinKey)
      };
    },

    async getLiveSessionSnapshot(input: {
      requestId: string;
      role: LiveSessionRole;
      joinKey?: string | null;
    }) {
      const request = await evaluateNoShowTimeout(input.requestId);
      const liveSession = request.liveSession;

      if (!liveSession) {
        throw new HttpError(404, "Live session not found.");
      }

      if (input.role === LIVE_SESSION_CUSTOMER_ROLE && input.joinKey !== liveSession.customerJoinKey) {
        throw new HttpError(401, "That customer join link is not valid.");
      }

      return {
        requestId: request.id,
        amountCents: request.amountCents,
        requestStatus: request.status,
        requestType: request.requestType,
        failureReason: request.failureReason,
        paymentStatus: getPaymentStatusLabel(request),
        liveSession: {
          id: liveSession.id,
          roomName: liveSession.roomName,
          status: liveSession.status,
          ownerConnected: liveSession.ownerConnected,
          customerConnected: liveSession.customerConnected,
          ownerVideoEnabled: liveSession.ownerVideoEnabled,
          ownerAudioEnabled: liveSession.ownerAudioEnabled,
          customerRequestedVideo: liveSession.customerRequestedVideo,
          customerVideoEnabled: liveSession.customerVideoEnabled,
          customerAudioEnabled: liveSession.customerAudioEnabled,
          customerAudioMuted: liveSession.customerAudioMuted,
          ownerJoinedAt: liveSession.ownerJoinedAt,
          customerJoinedAt: liveSession.customerJoinedAt,
          ownerJoinDeadlineAt: liveSession.ownerJoinDeadlineAt,
          completedAt: liveSession.completedAt,
          endedReason: liveSession.endedReason,
          joinPath: buildCustomerJoinPath(request.id, liveSession.customerJoinKey)
        }
      };
    },

    async handleLiveRoomEvent(input: {
      requestId: string;
      statusCallbackEvent: string;
      roomName?: string | null;
      roomSid?: string | null;
      participantIdentity?: string | null;
      participantDuration?: number | null;
      trackKind?: string | null;
    }) {
      const request = await getRequestOrThrow(input.requestId);
      const liveSession = request.liveSession;
      if (!liveSession) {
        return request;
      }

      const event = input.statusCallbackEvent.toLowerCase();
      const role = getParticipantRole(request, input.participantIdentity);
      const currentCallAttempt = latestCall(request);

      if (event === "participant-connected" && role) {
        const ownerConnected = role === LIVE_SESSION_OWNER_ROLE ? true : liveSession.ownerConnected;
        const customerConnected = role === LIVE_SESSION_CUSTOMER_ROLE ? true : liveSession.customerConnected;
        const nextSessionStatus = ownerConnected && customerConnected
          ? "joined"
          : ownerConnected
            ? "waiting_for_customer"
            : "waiting_for_owner";

        await prisma.$transaction(async (tx) => {
          await tx.liveSession.update({
            where: { id: liveSession.id },
            data: {
              roomName: input.roomName ?? liveSession.roomName,
              roomSid: input.roomSid ?? liveSession.roomSid,
              status: nextSessionStatus,
              ownerConnected,
              customerConnected,
              ownerJoinedAt:
                role === LIVE_SESSION_OWNER_ROLE ? liveSession.ownerJoinedAt ?? new Date() : liveSession.ownerJoinedAt,
              customerJoinedAt:
                role === LIVE_SESSION_CUSTOMER_ROLE ? liveSession.customerJoinedAt ?? new Date() : liveSession.customerJoinedAt,
              joinedAt:
                nextSessionStatus === "joined" ? liveSession.joinedAt ?? new Date() : liveSession.joinedAt
            }
          });

          if (currentCallAttempt) {
            await tx.callAttempt.update({
              where: { id: currentCallAttempt.id },
              data: {
                status: nextSessionStatus === "joined" ? "answered" : "ringing",
                roomName: input.roomName ?? currentCallAttempt.roomName,
                answeredAt:
                  nextSessionStatus === "joined"
                    ? currentCallAttempt.answeredAt ?? new Date()
                    : currentCallAttempt.answeredAt,
                failureReason: null
              }
            });
          }

          await tx.complimentRequest.update({
            where: { id: request.id },
            data: {
              status: nextSessionStatus === "joined" ? "answered" : "calling",
              answeredAt: nextSessionStatus === "joined" ? request.answeredAt ?? new Date() : request.answeredAt
            }
          });
        });

        return getRequestOrThrow(request.id);
      }

      if (event === "participant-disconnected" && role) {
        if (request.status === "completed") {
          await prisma.liveSession.update({
            where: { id: liveSession.id },
            data: {
              status: "completed",
              ownerConnected: role === LIVE_SESSION_OWNER_ROLE ? false : liveSession.ownerConnected,
              customerConnected: role === LIVE_SESSION_CUSTOMER_ROLE ? false : liveSession.customerConnected,
              ownerLeftAt: role === LIVE_SESSION_OWNER_ROLE ? new Date() : liveSession.ownerLeftAt,
              customerLeftAt: role === LIVE_SESSION_CUSTOMER_ROLE ? new Date() : liveSession.customerLeftAt
            }
          });
          return getRequestOrThrow(request.id);
        }

        const reason = role === LIVE_SESSION_OWNER_ROLE
          ? isFreeRequest(request)
            ? "The owner left the live compliment before completion was confirmed, so the free request was closed."
            : "The owner left the live compliment before completion was confirmed, so no charge was made."
          : isFreeRequest(request)
            ? "The customer disconnected before completion was confirmed, so the free request was closed."
            : "The customer disconnected before completion was confirmed, so no charge was made.";

        if (currentCallAttempt && input.participantDuration) {
          await prisma.callAttempt.update({
            where: { id: currentCallAttempt.id },
            data: {
              durationSeconds: input.participantDuration
            }
          });
        }

        if (isGiftRequest(request)) {
          return restoreGiftLink(request.id, "The compliment did not finish, so this gift link still works.", "dropped", "disconnected");
        }

        return cancelAuthorizedPaymentForRequest(request.id, reason, "dropped", "disconnected");
      }

      if (event === "room-ended") {
        if (request.status === "completed") {
          await prisma.liveSession.update({
            where: { id: liveSession.id },
            data: {
              status: "completed",
              completedAt: liveSession.completedAt ?? new Date(),
              endedReason: liveSession.endedReason
            }
          });
          return getRequestOrThrow(request.id);
        }

        if (isGiftRequest(request)) {
          const retryableReason = liveSession.ownerJoinedAt
            ? "The compliment ended before completion was confirmed, so this gift link still works."
            : "Not available right now, try again later. This gift link still works.";
          return restoreGiftLink(
            request.id,
            retryableReason,
            liveSession.ownerJoinedAt ? "dropped" : "no_answer",
            "failed"
          );
        }

        const reason = liveSession.ownerJoinedAt
          ? isFreeRequest(request)
            ? "The live compliment room ended before completion was confirmed, so the free request was closed."
            : "The live compliment room ended before completion was confirmed, so no charge was made."
          : isFreeRequest(request)
            ? "The owner never joined the live compliment room, so the free request was closed."
            : "The owner never joined the live compliment room, so no charge was made.";
        const callStatus = liveSession.ownerJoinedAt ? "dropped" : "no_answer";
        return cancelAuthorizedPaymentForRequest(request.id, reason, callStatus, "failed");
      }

      if (["track-added", "track-enabled", "track-disabled", "track-removed"].includes(event) && role && input.trackKind) {
        const enabled = event === "track-added" || event === "track-enabled";
        const removed = event === "track-removed" || event === "track-disabled";
        const isAudio = input.trackKind.toLowerCase() === "audio";
        const isVideo = input.trackKind.toLowerCase() === "video";

        if (isAudio || isVideo) {
          await prisma.liveSession.update({
            where: { id: liveSession.id },
            data: {
              ownerAudioEnabled:
                role === LIVE_SESSION_OWNER_ROLE && isAudio
                  ? enabled
                  : liveSession.ownerAudioEnabled,
              ownerVideoEnabled:
                role === LIVE_SESSION_OWNER_ROLE && isVideo
                  ? enabled
                  : liveSession.ownerVideoEnabled,
              customerAudioEnabled:
                role === LIVE_SESSION_CUSTOMER_ROLE && isAudio
                  ? enabled
                  : liveSession.customerAudioEnabled,
              customerAudioMuted:
                role === LIVE_SESSION_CUSTOMER_ROLE && isAudio
                  ? removed
                  : liveSession.customerAudioMuted,
              customerVideoEnabled:
                role === LIVE_SESSION_CUSTOMER_ROLE && isVideo
                  ? enabled
                  : liveSession.customerVideoEnabled
            }
          });
        }
      }

      if (event === "room-created" && input.roomSid) {
        await prisma.liveSession.update({
          where: { id: liveSession.id },
          data: {
            roomSid: input.roomSid
          }
        });
      }

      return getRequestOrThrow(request.id);
    },

    async markCompleted(requestId: string) {
      const request = await evaluateNoShowTimeout(requestId);
      const paymentAttempt = latestPayment(request);
      const callAttempt = latestCall(request);
      const liveSession = request.liveSession;

      if (request.status === "completed") {
        return request;
      }
      if (!liveSession || liveSession.status !== "joined" || !liveSession.ownerConnected || !liveSession.customerConnected) {
        throw new HttpError(409, "The live compliment session is not fully connected, so it cannot be completed safely.");
      }

      if (isFreeRequest(request)) {
        await prisma.$transaction(async (tx) => {
          if (callAttempt) {
            await tx.callAttempt.update({
              where: { id: callAttempt.id },
              data: {
                status: "completed",
                completedAt: new Date(),
                failureReason: null
              }
            });
          }

          await tx.liveSession.update({
            where: { id: liveSession.id },
            data: {
              status: "completed",
              completedAt: new Date(),
              endedReason: null
            }
          });

          await tx.complimentRequest.update({
            where: { id: request.id },
            data: {
              status: "completed",
              completedAt: new Date(),
              failureReason: null,
              freeUseConsumedAt: new Date()
            }
          });

          if (request.customerEmailNormalized) {
            await tx.freeComplimentIdentity.upsert({
              where: { normalizedEmail: request.customerEmailNormalized },
              update: {
                consumedAt: new Date(),
                lastAttemptAt: new Date(),
                hashedIpLastSeen: request.requesterIpHash,
                browserMarkerHashLastSeen: request.browserMarkerHash,
                userAgentHashLastSeen: request.userAgentHash,
                firstRequestId: request.id
              },
              create: {
                normalizedEmail: request.customerEmailNormalized,
                firstRequestId: request.id,
                consumedAt: new Date(),
                lastAttemptAt: new Date(),
                hashedIpLastSeen: request.requesterIpHash,
                browserMarkerHashLastSeen: request.browserMarkerHash,
                userAgentHashLastSeen: request.userAgentHash
              }
            });
          }
        });

        await closeRoom(liveSession.roomName);
        await maybePromoteNextQueuedRequest();
        return getRequestOrThrow(request.id);
      }

      if (!paymentAttempt || paymentAttempt.status !== "authorized") {
        throw new HttpError(409, "There is no live authorization to capture for this request.");
      }

      const targetId = getProviderTargetId(paymentAttempt);
      if (!targetId) {
        throw new HttpError(409, "The payment authorization is missing its provider id.");
      }

      let paymentStatus: PaymentAttemptStatus = "captured";
      let paymentFailureReason: string | null = null;

      try {
        if (paymentAttempt.provider === "stripe") {
          await dependencies.stripe.capture(targetId);
        } else {
          await dependencies.paypal.capture(targetId);
        }
      } catch (error) {
        paymentStatus = "failed";
        paymentFailureReason = `Capture failed, so the customer was not charged. ${extractErrorMessage(error)}`;
      }

      await prisma.$transaction(async (tx) => {
        await tx.paymentAttempt.update({
          where: { id: paymentAttempt.id },
          data: {
            status: paymentStatus,
            capturedAt: paymentStatus === "captured" ? new Date() : null,
            failureReason: paymentFailureReason
          }
        });

        if (callAttempt) {
          await tx.callAttempt.update({
            where: { id: callAttempt.id },
            data: {
              status: "completed",
              completedAt: new Date(),
              failureReason: paymentFailureReason
            }
          });
        }

        await tx.liveSession.update({
          where: { id: liveSession.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            endedReason: paymentFailureReason
          }
        });

        await tx.complimentRequest.update({
          where: { id: request.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            failureReason: paymentFailureReason,
            giftRedemptionStatus: isGiftRequest(request) ? "redeemed" : request.giftRedemptionStatus,
            giftRedeemedAt: isGiftRequest(request) ? new Date() : request.giftRedeemedAt
          }
        });
      });

      await closeRoom(liveSession.roomName);
      await maybePromoteNextQueuedRequest();
      return getRequestOrThrow(request.id);
    },

    async markNotCompleted(requestId: string) {
      const request = await evaluateNoShowTimeout(requestId);

      if (isGiftRequest(request)) {
        return restoreGiftLink(
          requestId,
          "The compliment was not completed, so this gift link still works.",
          "failed",
          "failed"
        );
      }

      return cancelAuthorizedPaymentForRequest(
        requestId,
        isFreeRequest(request)
          ? "The owner marked the free compliment as not completed."
          : "The owner marked the compliment as not completed, so no charge was made.",
        "failed",
        "failed"
      );
    },

    async syncPaymentAttemptStatus(input: {
      provider: PaymentProvider;
      externalPaymentId: string;
      status: PaymentAttemptStatus;
      failureReason?: string | null;
    }) {
      const request = await getRequestByExternalPayment(input.provider, input.externalPaymentId);
      if (!request) {
        return null;
      }

      const paymentAttempt = latestPayment(request);
      if (!paymentAttempt) {
        return request;
      }

      await prisma.paymentAttempt.update({
        where: { id: paymentAttempt.id },
        data: {
          status: input.status,
          failureReason: input.failureReason ?? paymentAttempt.failureReason,
          capturedAt: input.status === "captured" ? new Date() : paymentAttempt.capturedAt,
          canceledAt: input.status === "canceled" ? new Date() : paymentAttempt.canceledAt
        }
      });

      if ((input.status === "failed" || input.status === "canceled") && request.status !== "completed") {
        if (request.liveSession) {
          await prisma.liveSession.update({
            where: { id: request.liveSession.id },
            data: {
              status: "failed",
              endedReason: input.failureReason ?? "The payment authorization was no longer valid.",
              disconnectedAt: new Date()
            }
          });
          await closeRoom(request.liveSession.roomName);
        }

        await prisma.complimentRequest.update({
          where: { id: request.id },
          data: {
            status: "failed",
            failureReason: input.failureReason ?? "The payment authorization was no longer valid.",
            failedAt: new Date(),
            giftRedemptionStatus: isGiftRequest(request) ? "canceled" : request.giftRedemptionStatus,
            ownerAlertSentAt: isGiftRequest(request) ? null : request.ownerAlertSentAt
          }
        });

        await maybePromoteNextQueuedRequest();
      }

      return getRequestOrThrow(request.id);
    },

    async getAdminDashboardData() {
      await ensureBootstrapData();
      await expireQueuedRequests();
      await maybePromoteNextQueuedRequest();

      const [availability, activeRequest, queuedRequests, recentRequests] = await Promise.all([
        getPublicAvailability(),
        prisma.complimentRequest.findFirst({
          where: {
            status: {
              in: ACTIVE_STATUS_VALUES
            }
          },
          include: requestInclude,
          orderBy: {
            createdAt: "asc"
          }
        }),
        prisma.complimentRequest.findMany({
          where: buildEligibleQueueWhere(new Date()),
          include: requestInclude,
          orderBy: QUEUE_ORDER_BY
        }),
        prisma.complimentRequest.findMany({
          include: requestInclude,
          orderBy: {
            createdAt: "desc"
          },
          take: 20
        })
      ]);

      return {
        availability,
        activeRequest,
        queuedRequests: queuedRequests.map((request, index) => ({
          ...request,
          queuePosition: index + (activeRequest ? 2 : 1),
          paymentStatusLabel: getPaymentStatusLabel(request)
        })),
        queueCount: queuedRequests.length,
        queueMax: MAX_WAITING_QUEUE_SIZE,
        recentRequests: recentRequests.map((request) => ({
          ...request,
          paymentStatusLabel: getPaymentStatusLabel(request)
        }))
      };
    },

    async cancelQueuedRequest(requestId: string) {
      const request = await expireQueuedRequestIfNeeded(requestId);
      if (request.status !== "queued") {
        throw new HttpError(409, "That request is not waiting in line anymore.");
      }

      if (isGiftRequest(request)) {
        return restoreGiftLink(
          requestId,
          "The owner removed this request from the line, so this gift link still works.",
          "failed",
          "failed"
        );
      }

      return cancelAuthorizedPaymentForRequest(
        requestId,
        isFreeRequest(request)
          ? "The owner removed this free request from the line."
          : "The owner removed this request from the line, so no charge was made.",
        "failed",
        "failed",
        {
          nextRequestStatus: "canceled"
        }
      );
    },

    async promoteNextQueuedRequest() {
      return promoteNextQueuedRequest();
    },

    buildQueueWaitPath(requestId: string, token: string, tokenType: "requestKey" | "accessToken" = "requestKey") {
      return buildQueueWaitPath(requestId, token, tokenType);
    }
  };
}

export const complimentService = createComplimentService();





