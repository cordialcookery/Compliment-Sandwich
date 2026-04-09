import "server-only";

import { prisma } from "@/lib/prisma";

export async function ensureBootstrapData() {
  await prisma.serviceAvailability.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      isAvailable: true
    }
  });

  await prisma.adminConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      destinationPhoneMask: null,
      allowPhoneOverride: false
    }
  });
}

