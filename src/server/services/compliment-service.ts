import "server-only";

import { randomUUID } from "node:crypto";

import {
  CallAttemptStatus,
  ComplimentRequestStatus,
  PaymentAttemptStatus,
  PaymentMethodType,
  PaymentProvider,
  Prisma
} from "@prisma/client";

import { createLiveAccessToken, createLiveRoom, completeLiveRoom } from "@/src/server/live/twilio-video";
import { getServerEnv } from "@/src/lib/env";
import { validateMinimumAmount } from "@/src/lib/amount";
import { ACTIVE_REQUEST_STATUSES } from "@/src/lib/constants";
import {
  buildCustomerJoinPath,
  LIVE_SESSION_ACTIVE_STATUSES,
  LIVE_SESSION_CUSTOMER_ROLE,
  LIVE_SESSION_OWNER_ROLE,
  type LiveSessionRole
} from "@/src/lib/live-session";
import { HttpError } from "@/src/lib/http";
import { maskPhoneNumber, normalizeUsPhone } from "@/src/lib/phone";
import { ensureBootstrapData } from "@/src/server/bootstrap";
import { prisma } from "@/lib/prisma";
import { paymentGateways } from "@/src/server/payments";
import { assertCanAcceptComplimentRequests, getPublicAvailability } from "@/src/server/services/availability";

const ACTIVE_STATUS_VALUES = ACTIVE_REQUEST_STATUSES as unknown as ComplimentRequestStatus[];
const ACTIVE_LIVE_SESSION_VALUES = LIVE_SESSION_ACTIVE_STATUSES as unknown as Array<
  RequestWithAttempts["liveSession"] extends { status: infer T } ? T : never
>;
const BUSY_MESSAGE = "Sorry, the compliment kitchen is busy right now. Try again in a minute.";

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

type ServiceDependencies = {
  createRoom: typeof createLiveRoom;
  completeRoom: typeof completeLiveRoom;
  stripe: {
    capture: (paymentIntentId: string) => Promise<unknown>;
    cancel: (paymentIntentId: string) => Promise<unknown>;
  };
  paypal: {
    capture: (authorizationId: string) => Promise<unknown>;
    cancel: (authorizationId: string) => Promise<unknown>;
  };
};

const defaultDependencies: ServiceDependencies = {
  createRoom: createLiveRoom,
  completeRoom: completeLiveRoom,
  stripe: paymentGateways.stripe,
  paypal: paymentGateways.paypal
};

function latestPayment(request: RequestWithAttempts) {
  return request.paymentAttempts[0] ?? null;
}

function latestCall(request: RequestWithAttempts) {
  return request.callAttempts[0] ?? null;
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

export function createComplimentService(overrides: Partial<ServiceDependencies> = {}) {
  const dependencies: ServiceDependencies = {
    ...defaultDependencies,
    ...overrides,
    stripe: {
      ...defaultDependencies.stripe,
      ...overrides.stripe
    },
    paypal: {
      ...defaultDependencies.paypal,
      ...overrides.paypal
    }
  };

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

  async function markBusyAfterAuthorization(input: {
    requestId: string;
    provider: PaymentProvider;
    externalPaymentId: string;
    authorizationId?: string | null;
    paymentMethodType: PaymentMethodType;
    idempotencyKey: string;
  }) {
    try {
      await releaseExternalAuthorization(input);
    } catch {
      // If release fails, the request still fails closed in our system.
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
            status: "canceled",
            failureReason: BUSY_MESSAGE,
            canceledAt: new Date()
          }
        });
      }

      await tx.complimentRequest.update({
        where: { id: input.requestId },
        data: {
          status: "failed",
          failureReason: BUSY_MESSAGE,
          failedAt: new Date()
        }
      });
    });
  }

  async function cancelAuthorizedPaymentForRequest(
    requestId: string,
    reason: string,
    nextCallStatus: CallAttemptStatus = "failed",
    nextLiveStatus: "disconnected" | "failed" = "failed"
  ) {
    const request = await getRequestOrThrow(requestId);
    const paymentAttempt = latestPayment(request);
    const callAttempt = latestCall(request);
    const liveSession = request.liveSession;

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
          status: "failed",
          failureReason: reason,
          failedAt: new Date()
        }
      });
    });

    await closeRoom(liveSession?.roomName);
    return getRequestOrThrow(requestId);
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
      return cancelAuthorizedPaymentForRequest(
        request.id,
        "The owner never joined the live compliment room in time, so no charge was made.",
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
    }) {
      validateMinimumAmount(input.amountCents);
      await ensureBootstrapData();
      await assertCanAcceptComplimentRequests();

      const normalizedPhone = input.customerPhoneRaw?.trim() ? normalizeUsPhone(input.customerPhoneRaw) : null;
      const existing = await getRequestByClientRequestId(input.clientRequestId);
      if (existing) {
        return existing;
      }

      const activeRequest = await prisma.complimentRequest.findFirst({
        where: {
          status: {
            in: ACTIVE_STATUS_VALUES
          }
        },
        select: {
          id: true
        }
      });

      if (activeRequest) {
        throw new HttpError(409, BUSY_MESSAGE);
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

    async confirmAuthorizedPayment(input: {
      requestId: string;
      provider: PaymentProvider;
      paymentMethodType: PaymentMethodType;
      externalPaymentId: string;
      authorizationId?: string | null;
      idempotencyKey: string;
      customerRequestedVideo: boolean;
    }) {
      let request: RequestWithAttempts;

      try {
        request = await prisma.$transaction(async (tx) => {
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

          const otherActiveRequest = await tx.complimentRequest.findFirst({
            where: {
              id: { not: current.id },
              status: {
                in: ACTIVE_STATUS_VALUES
              }
            }
          });

          if (otherActiveRequest) {
            throw new HttpError(409, BUSY_MESSAGE);
          }

          const paymentAttempt = latestPayment(current);
          if (paymentAttempt?.status === "authorized" && current.liveSession) {
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
              failureReason: null
            },
            include: requestInclude
          });
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409 && error.message === BUSY_MESSAGE) {
          await markBusyAfterAuthorization(input);
        }
        throw error;
      }

      if (request.liveSession) {
        return request;
      }

      try {
        const room = await dependencies.createRoom({ requestId: request.id });
        const env = getServerEnv();
        const liveSession = await prisma.liveSession.create({
          data: {
            complimentRequestId: request.id,
            roomName: room.roomName,
            roomSid: room.roomSid,
            customerJoinKey: randomUUID(),
            ownerIdentity: `owner-${request.id}`,
            customerIdentity: `customer-${request.id}`,
            status: "waiting_for_owner",
            customerRequestedVideo: input.customerRequestedVideo,
            customerVideoEnabled: input.customerRequestedVideo,
            ownerJoinDeadlineAt: new Date(Date.now() + env.LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS * 1000)
          }
        });

        const existingCallAttempt = latestCall(request);
        if (existingCallAttempt) {
          await prisma.callAttempt.update({
            where: { id: existingCallAttempt.id },
            data: {
              status: "initiated",
              direction: "browser",
              roomName: room.roomName,
              failureReason: null,
              completedAt: null
            }
          });
        } else {
          await prisma.callAttempt.create({
            data: {
              complimentRequestId: request.id,
              status: "initiated",
              direction: "browser",
              roomName: room.roomName
            }
          });
        }

        await prisma.complimentRequest.update({
          where: { id: request.id },
          data: {
            status: "calling"
          }
        });

        return getRequestOrThrow(liveSession.complimentRequestId);
      } catch (error) {
        await cancelAuthorizedPaymentForRequest(
          request.id,
          `The live compliment room could not be created, so no charge was made. ${extractErrorMessage(error)}`,
          "failed",
          "failed"
        );
        throw new HttpError(502, "The live compliment room could not be created, so no charge was made.");
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
        failureReason: request.failureReason,
        paymentStatus: latestPayment(request)?.status ?? "requires_payment_method",
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
          ? "The owner left the live compliment before completion was confirmed, so no charge was made."
          : "The customer disconnected before completion was confirmed, so no charge was made.";

        if (currentCallAttempt && input.participantDuration) {
          await prisma.callAttempt.update({
            where: { id: currentCallAttempt.id },
            data: {
              durationSeconds: input.participantDuration
            }
          });
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

        const reason = liveSession.ownerJoinedAt
          ? "The live compliment room ended before completion was confirmed, so no charge was made."
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
      if (!paymentAttempt || paymentAttempt.status !== "authorized") {
        throw new HttpError(409, "There is no live authorization to capture for this request.");
      }
      if (!liveSession || liveSession.status !== "joined" || !liveSession.ownerConnected || !liveSession.customerConnected) {
        throw new HttpError(409, "The live compliment session is not fully connected, so it cannot be captured safely.");
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
            failureReason: paymentFailureReason
          }
        });
      });

      await closeRoom(liveSession.roomName);
      return getRequestOrThrow(request.id);
    },

    async markNotCompleted(requestId: string) {
      return cancelAuthorizedPaymentForRequest(
        requestId,
        "The owner marked the compliment as not completed, so no charge was made.",
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
            failedAt: new Date()
          }
        });
      }

      return getRequestOrThrow(request.id);
    },

    async getAdminDashboardData() {
      await ensureBootstrapData();
      const [availability, activeRequest, recentRequests] = await Promise.all([
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
        recentRequests
      };
    }
  };
}

export const complimentService = createComplimentService();


