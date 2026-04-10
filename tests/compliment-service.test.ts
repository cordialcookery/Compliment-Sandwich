import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { ensureBootstrapData } from "@/src/server/bootstrap";
import { setAvailability } from "@/src/server/services/availability";
import { createComplimentService } from "@/src/server/services/compliment-service";

function buildHarness() {
  const createRoom = vi.fn(async ({ requestId }: { requestId: string }) => ({
    roomName: `room_${requestId}_${randomUUID()}`,
    roomSid: `RM_${randomUUID()}`
  }));
  const completeRoom = vi.fn(async () => ({ sid: `RM_${randomUUID()}` }));
  const stripeCapture = vi.fn(async () => ({ id: `cap_${randomUUID()}` }));
  const stripeCancel = vi.fn(async () => ({ id: `void_${randomUUID()}` }));
  const paypalCapture = vi.fn(async () => ({ id: `cap_${randomUUID()}` }));
  const paypalCancel = vi.fn(async () => ({ id: `void_${randomUUID()}` }));
  const sendOwnerAlert = vi.fn(async () => undefined);
  const sendCustomerAccessEmail = vi.fn(async () => ({ sent: true }));

  return {
    createRoom,
    completeRoom,
    stripeCapture,
    stripeCancel,
    paypalCapture,
    paypalCancel,
    sendOwnerAlert,
    sendCustomerAccessEmail,
    service: createComplimentService({
      createRoom,
      completeRoom,
      stripe: {
        capture: stripeCapture,
        cancel: stripeCancel
      },
      paypal: {
        capture: paypalCapture,
        cancel: paypalCancel
      },
      sendOwnerAlert,
      sendCustomerAccessEmail
    })
  };
}

async function resetDatabase() {
  await prisma.liveSession.deleteMany();
  await prisma.callAttempt.deleteMany();
  await prisma.paymentAttempt.deleteMany();
  await prisma.complimentRequest.deleteMany();
  await prisma.freeComplimentIdentity.deleteMany();
  await prisma.rateLimitEvent.deleteMany();
  await prisma.adminConfig.deleteMany();
  await prisma.serviceAvailability.deleteMany();
  await ensureBootstrapData();
  await setAvailability(true);
}

async function createPaidPending(
  service: ReturnType<typeof buildHarness>["service"],
  requestType: "self_paid" | "gift_paid" = "self_paid",
  amountCents = 500
) {
  return service.createPendingRequest({
    clientRequestId: randomUUID(),
    amountCents,
    customerPhoneRaw: null,
    provider: "stripe",
    paymentMethodType: "card",
    requestType
  });
}

async function authorizePaid(
  service: ReturnType<typeof buildHarness>["service"],
  requestId: string,
  customerRequestedVideo = false
) {
  return service.confirmAuthorizedPayment({
    requestId,
    provider: "stripe",
    paymentMethodType: "card",
    externalPaymentId: `pi_${randomUUID()}`,
    authorizationId: `pi_${randomUUID()}`,
    idempotencyKey: randomUUID(),
    customerRequestedVideo
  });
}

async function createFree(
  service: ReturnType<typeof buildHarness>["service"],
  email: string,
  customerRequestedVideo = false,
  clientRequestId = randomUUID()
) {
  return service.createFreeRequest({
    clientRequestId,
    email,
    customerRequestedVideo,
    actor: "127.0.0.1",
    browserMarker: `browser-${email}`,
    userAgent: "vitest"
  });
}

async function connectJoined(
  service: ReturnType<typeof buildHarness>["service"],
  requestId: string,
  ownerIdentity?: string | null,
  customerIdentity?: string | null
) {
  if (!ownerIdentity || !customerIdentity) {
    const request = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { liveSession: true }
    });
    ownerIdentity = request.liveSession?.ownerIdentity;
    customerIdentity = request.liveSession?.customerIdentity;
  }

  await service.handleLiveRoomEvent({
    requestId,
    statusCallbackEvent: "participant-connected",
    participantIdentity: customerIdentity
  });
  await service.handleLiveRoomEvent({
    requestId,
    statusCallbackEvent: "participant-connected",
    participantIdentity: ownerIdentity
  });
}

describe("compliment request lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("starts a paid self request immediately when idle", async () => {
    const harness = buildHarness();
    const pending = await createPaidPending(harness.service, "self_paid");

    const active = await authorizePaid(harness.service, pending.id, false);

    expect(active.status).toBe("calling");
    expect(active.requestType).toBe("self_paid");
    expect(active.liveSession?.roomName).toMatch(/^room_/);
    expect(harness.createRoom).toHaveBeenCalledTimes(1);
  });

  it("promotes paid queued requests ahead of free queued requests", async () => {
    const harness = buildHarness();
    const activePending = await createPaidPending(harness.service, "self_paid");
    const active = await authorizePaid(harness.service, activePending.id, false);

    const free = await createFree(harness.service, "free-first@example.com", false);
    expect(free.request.status).toBe("queued");

    const paidPending = await createPaidPending(harness.service, "self_paid", 900);
    const paidQueued = await authorizePaid(harness.service, paidPending.id, true);
    expect(paidQueued.status).toBe("queued");

    const freeSnapshot = await harness.service.getQueueSnapshot({
      requestId: free.request.id,
      accessToken: free.accessToken
    });
    const paidSnapshot = await harness.service.getQueueSnapshot({
      requestId: paidQueued.id,
      requestKey: paidQueued.clientRequestId
    });

    expect(paidSnapshot.position).toBe(2);
    expect(freeSnapshot.position).toBe(3);

    await harness.service.markNotCompleted(active.id);

    const promotedPaid = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: paidQueued.id },
      include: { liveSession: true }
    });
    const stillQueuedFree = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: free.request.id }
    });

    expect(promotedPaid.status).toBe("calling");
    expect(promotedPaid.liveSession).not.toBeNull();
    expect(stillQueuedFree.status).toBe("queued");
  });

  it("keeps paid requests FIFO within the paid tier", async () => {
    const harness = buildHarness();
    const activePending = await createPaidPending(harness.service, "self_paid");
    const active = await authorizePaid(harness.service, activePending.id, false);

    const firstQueuedPending = await createPaidPending(harness.service, "self_paid", 700);
    const firstQueued = await authorizePaid(harness.service, firstQueuedPending.id, false);
    const secondQueuedPending = await createPaidPending(harness.service, "self_paid", 800);
    const secondQueued = await authorizePaid(harness.service, secondQueuedPending.id, false);

    await harness.service.markNotCompleted(active.id);

    const promotedFirst = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: firstQueued.id }
    });
    const stillQueuedSecond = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: secondQueued.id }
    });

    expect(promotedFirst.status).toBe("calling");
    expect(stillQueuedSecond.status).toBe("queued");
  });

  it("lets a gift redemption enter the queue when the service is busy without consuming the gift", async () => {
    const harness = buildHarness();
    const activePending = await createPaidPending(harness.service, "self_paid");
    await authorizePaid(harness.service, activePending.id, false);

    const giftPending = await createPaidPending(harness.service, "gift_paid", 1200);
    const gifted = await authorizePaid(harness.service, giftPending.id, false);

    const queuedGift = await harness.service.redeemGift({
      giftToken: gifted.giftToken!,
      customerRequestedVideo: false
    });

    expect(queuedGift.status).toBe("queued");
    expect(queuedGift.giftRedemptionStatus).toBe("redeeming");
    expect(queuedGift.liveSession).toBeNull();
    expect(harness.createRoom).toHaveBeenCalledTimes(1);

    const snapshot = await harness.service.getGiftSnapshot(gifted.giftToken!);
    expect(snapshot.state).toBe("queued");

    const restored = await harness.service.markNotCompleted(queuedGift.id);
    expect(restored.status).toBe("payment_authorized");
    expect(restored.giftRedemptionStatus).toBe("link_ready");
  });

  it("creates a free request without a payment attempt", async () => {
    const harness = buildHarness();
    const free = await createFree(harness.service, "first-free@example.com", true);

    const stored = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: free.request.id },
      include: { paymentAttempts: true, liveSession: true }
    });

    expect(stored.requestType).toBe("self_free");
    expect(stored.queuePriority).toBe("free");
    expect(stored.paymentAttempts).toHaveLength(0);
    expect(free.emailSent).toBe(true);
  });

  it("blocks another free compliment after one completed for the same normalized email", async () => {
    const harness = buildHarness();
    const free = await createFree(harness.service, "One@Example.com", false);

    await connectJoined(harness.service, free.request.id);
    await harness.service.markCompleted(free.request.id);

    await expect(createFree(harness.service, "one@example.com", false)).rejects.toThrow("already used");
  });

  it("blocks another active or queued free compliment for the same email", async () => {
    const harness = buildHarness();
    const activePending = await createPaidPending(harness.service, "self_paid");
    await authorizePaid(harness.service, activePending.id, false);

    await createFree(harness.service, "lineup@example.com", false);

    await expect(createFree(harness.service, "lineup@example.com", true)).rejects.toThrow("already has a free compliment in progress");
  });

  it("does not create extra rooms for queued requests before promotion", async () => {
    const harness = buildHarness();
    const activePending = await createPaidPending(harness.service, "self_paid");
    const active = await authorizePaid(harness.service, activePending.id, false);
    const queuedPending = await createPaidPending(harness.service, "self_paid", 650);
    const queued = await authorizePaid(harness.service, queuedPending.id, false);

    expect(queued.status).toBe("queued");
    expect(harness.createRoom).toHaveBeenCalledTimes(1);

    await harness.service.markNotCompleted(active.id);

    expect(harness.createRoom).toHaveBeenCalledTimes(2);
  });

  it("captures paid requests only after completion and never while queued", async () => {
    const harness = buildHarness();
    const activePending = await createPaidPending(harness.service, "self_paid");
    const active = await authorizePaid(harness.service, activePending.id, false);
    const queuedPending = await createPaidPending(harness.service, "self_paid", 800);
    const queued = await authorizePaid(harness.service, queuedPending.id, false);

    const queuedBefore = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: queued.id },
      include: { paymentAttempts: { orderBy: { createdAt: "desc" } } }
    });
    expect(queuedBefore.paymentAttempts[0]?.status).toBe("authorized");

    await connectJoined(harness.service, active.id);
    await harness.service.markCompleted(active.id);

    const promoted = await prisma.complimentRequest.findUniqueOrThrow({
      where: { id: queued.id },
      include: { liveSession: true, paymentAttempts: { orderBy: { createdAt: "desc" } } }
    });
    expect(promoted.status).toBe("calling");
    expect(promoted.paymentAttempts[0]?.status).toBe("authorized");

    await connectJoined(harness.service, promoted.id, promoted.liveSession?.ownerIdentity, promoted.liveSession?.customerIdentity);
    const completed = await harness.service.markCompleted(promoted.id);

    expect(completed.paymentAttempts[0]?.status).toBe("captured");
  });
});
