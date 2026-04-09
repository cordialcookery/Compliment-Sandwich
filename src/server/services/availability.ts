import "server-only";

import { ComplimentRequestStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ACTIVE_REQUEST_STATUSES } from "@/src/lib/constants";
import { HttpError } from "@/src/lib/http";
import { ensureBootstrapData } from "@/src/server/bootstrap";

const ACTIVE_STATUS_VALUES = ACTIVE_REQUEST_STATUSES as unknown as ComplimentRequestStatus[];
const SAFE_UNAVAILABLE_RESPONSE = {
  availableNow: false,
  label: "Currently unavailable",
  reason: "The compliment kitchen is having a database moment. Please try again in a minute."
};

export async function findActiveRequest() {
  await ensureBootstrapData();
  return prisma.complimentRequest.findFirst({
    where: {
      status: {
        in: ACTIVE_STATUS_VALUES
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  });
}

export async function getPublicAvailability() {
  try {
    await ensureBootstrapData();
    const [availability, activeRequest] = await Promise.all([
      prisma.serviceAvailability.findUnique({ where: { id: 1 } }),
      prisma.complimentRequest.findFirst({
        where: {
          status: {
            in: ACTIVE_STATUS_VALUES
          }
        },
        orderBy: {
          createdAt: "asc"
        }
      })
    ]);

    const adminEnabled = availability?.isAvailable ?? true;
    const availableNow = adminEnabled && !activeRequest;

    if (availableNow) {
      return {
        availableNow: true,
        label: "Available now",
        reason: null
      };
    }

    if (!adminEnabled) {
      return {
        availableNow: false,
        label: "Currently unavailable",
        reason: availability?.ownerMessage || "The compliment kitchen is closed right now."
      };
    }

    return {
      availableNow: false,
      label: "Currently unavailable",
      reason: "Sorry, the compliment kitchen is busy right now. Try again in a minute."
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
