import "server-only";

import { RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MINUTES } from "@/src/lib/constants";
import { hashValue } from "@/src/lib/crypto";
import { HttpError } from "@/src/lib/http";
import { prisma } from "@/lib/prisma";

export async function enforceRateLimit(routeKey: string, actor: string) {
  const actorHash = hashValue(actor);
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000);

  await prisma.rateLimitEvent.create({
    data: {
      actorHash,
      routeKey
    }
  });

  const count = await prisma.rateLimitEvent.count({
    where: {
      actorHash,
      routeKey,
      createdAt: {
        gte: windowStart
      }
    }
  });

  if (count > RATE_LIMIT_MAX_ATTEMPTS) {
    throw new HttpError(429, "Slow down a little bit and try again in a minute.");
  }

  await prisma.rateLimitEvent.deleteMany({
    where: {
      createdAt: {
        lt: windowStart
      }
    }
  });
}

