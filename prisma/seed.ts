import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
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

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
