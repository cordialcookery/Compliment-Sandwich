import "server-only";

import { ComplimentRequestStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ACTIVE_REQUEST_STATUSES, MAX_WAITING_QUEUE_SIZE } from "@/src/lib/constants";
import { HttpError } from "@/src/lib/http";
import { ensureBootstrapData } from "@/src/server/bootstrap";

const ACTIVE_STATUS_VALUES = ACTIVE_REQUEST_STATUSES as unknown as ComplimentRequestStatus[];
const SAFE_UNAVAILABLE_RESPONSE = {
  availableNow: false,
  label: "Currently unavailable",
  reason: "The compliment kitchen is having a database moment. Please try again in a minute.",
  canStartImmediately: false,
  canJoinQueue: false,
  serviceEnabled: false,
  hasActiveRequest: false,
  queueCount: 0,
  queueMax: MAX_WAITING_QUEUE_SIZE
};

function buildActiveRequestWhere(): Prisma.ComplimentRequestWhereInput {
  return {
    status: {
      in: ACTIVE_STATUS_VALUES
    }
  };
}

function buildQueuedRequestWhere(now = new Date()): Prisma.ComplimentRequestWhereInput {
  return {
    status: "queued",
    OR: [
      { queueExpiresAt: null },
      { queueExpiresAt: { gt: now } }
    ]
  };
}

export async function findActiveRequest() {
  await ensureBootstrapData();
  return prisma.complimentRequest.findFirst({
    where: buildActiveRequestWhere(),
    orderBy: {
      createdAt: "asc"
    }
  });
}

export async function findQueuedRequests() {
  await ensureBootstrapData();
  return prisma.complimentRequest.findMany({
    where: buildQueuedRequestWhere(),
    orderBy: [
      { queuePriority: "asc" },
      { queuedAt: "asc" },
      { createdAt: "asc" }
    ]
  });
}

export async function getPublicAvailability() {
  try {
    await ensureBootstrapData();
    const now = new Date();
    const [availability, activeRequest, queuedCount] = await Promise.all([
      prisma.serviceAvailability.findUnique({ where: { id: 1 } }),
      prisma.complimentRequest.findFirst({
        where: buildActiveRequestWhere(),
        orderBy: {
          createdAt: "asc"
        }
      }),
      prisma.complimentRequest.count({
        where: buildQueuedRequestWhere(now)
      })
    ]);

    const adminEnabled = availability?.isAvailable ?? true;
    const canStartImmediately = adminEnabled && !activeRequest && queuedCount === 0;
    const canJoinQueue = adminEnabled && queuedCount < MAX_WAITING_QUEUE_SIZE;
    const availableNow = adminEnabled && (canStartImmediately || canJoinQueue);

    if (!adminEnabled) {
      return {
        availableNow: false,
        label: "Currently unavailable",
        reason: availability?.ownerMessage || "The compliment kitchen is closed right now.",
        canStartImmediately: false,
        canJoinQueue: false,
        serviceEnabled: false,
        hasActiveRequest: Boolean(activeRequest),
        queueCount: queuedCount,
        queueMax: MAX_WAITING_QUEUE_SIZE
      };
    }

    if (canStartImmediately) {
      return {
        availableNow: true,
        label: "Available now",
        reason: null,
        canStartImmediately: true,
        canJoinQueue: true,
        serviceEnabled: true,
        hasActiveRequest: false,
        queueCount: queuedCount,
        queueMax: MAX_WAITING_QUEUE_SIZE
      };
    }

    if (canJoinQueue) {
      return {
        availableNow: true,
        label: "Available now",
        reason: activeRequest
          ? "One compliment is already in progress, but the line is open."
          : "The line is already moving. New requests will join the queue.",
        canStartImmediately: false,
        canJoinQueue: true,
        serviceEnabled: true,
        hasActiveRequest: Boolean(activeRequest),
        queueCount: queuedCount,
        queueMax: MAX_WAITING_QUEUE_SIZE
      };
    }

    return {
      availableNow: false,
      label: "Currently unavailable",
      reason: "Sorry, the line is full right now.",
      canStartImmediately: false,
      canJoinQueue: false,
      serviceEnabled: true,
      hasActiveRequest: Boolean(activeRequest),
      queueCount: queuedCount,
      queueMax: MAX_WAITING_QUEUE_SIZE
    };
  } catch (error) {
    console.error("Failed to load public availability.", error);
    return SAFE_UNAVAILABLE_RESPONSE;
  }
}

export async function assertCanAcceptComplimentRequests() {
  const availability = await getPublicAvailability();
  if (!availability.availableNow) {
    throw new HttpError(409, availability.reason || "Compliments are unavailable right now.");
  }
}

export async function setAvailability(isAvailable: boolean, ownerMessage?: string | null) {
  await ensureBootstrapData();
  return prisma.serviceAvailability.update({
    where: { id: 1 },
    data: {
      isAvailable,
      ownerMessage: ownerMessage?.trim() ? ownerMessage.trim() : null
    }
  });
}
