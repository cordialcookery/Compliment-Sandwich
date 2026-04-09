import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { ensureBootstrapData } from "@/src/server/bootstrap";
import { setAvailability } from "@/src/server/services/availability";
import { createComplimentService } from "@/src/server/services/compliment-service";

function buildService(overrides: {
  sendOwnerAlert?: (input: { requestId: string; amountCents: number }) => Promise<unknown>;
} = {}) {
  return createComplimentService({
    createRoom: vi.fn(async ({ requestId }) => ({
      roomName: `room_${requestId}`,
      roomSid: `RM_${randomUUID()}`
    })),
    completeRoom: vi.fn(async () => ({ sid: `RM_${randomUUID()}` })),
    stripe: {
      capture: vi.fn(async () => ({ id: `cap_${randomUUID()}` })),
      cancel: vi.fn(async () => ({ id: `void_${randomUUID()}` }))
    },
    paypal: {
      capture: vi.fn(async () => ({ id: `cap_${randomUUID()}` })),
      cancel: vi.fn(async () => ({ id: `void_${randomUUID()}` }))
    },
    sendOwnerAlert: overrides.sendOwnerAlert ?? vi.fn(async () => undefined)
  });
}

async function resetDatabase() {
  await prisma.liveSession.deleteMany();
  await prisma.callAttempt.deleteMany();
  await prisma.paymentAttempt.deleteMany();
  await prisma.complimentRequest.deleteMany();
  await prisma.rateLimitEvent.deleteMany();
  await prisma.adminConfig.deleteMany();
  await prisma.serviceAvailability.deleteMany();
  await ensureBootstrapData();
  await setAvailability(true);
}

async function createAuthorizedRequest(service: ReturnType<typeof buildService>, input?: { customerRequestedVideo?: boolean }) {
  const request = await service.createPendingRequest({
    clientRequestId: randomUUID(),
    amountCents: 500,
    customerPhoneRaw: null,
    provider: "stripe",
    paymentMethodType: "card"
  });

  return service.confirmAuthorizedPayment({
    requestId: request.id,
    provider: "stripe",
    paymentMethodType: "card",
    externalPaymentId: `pi_${randomUUID()}`,
    authorizationId: `pi_${randomUUID()}`,
    idempotencyKey: randomUUID(),
    customerRequestedVideo: input?.customerRequestedVideo ?? false
  });
}

describe("compliment service live sessions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("captures payment when the customer joins audio-only and the owner completes", async () => {
    const service = buildService();
    const request = await createAuthorizedRequest(service, { customerRequestedVideo: false });

    await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      roomName: request.liveSession?.roomName,
      roomSid: request.liveSession?.roomSid,
      participantIdentity: request.liveSession?.customerIdentity
    });

    await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      roomName: request.liveSession?.roomName,
      roomSid: request.liveSession?.roomSid,
      participantIdentity: request.liveSession?.ownerIdentity
    });

    const completed = await service.markCompleted(request.id);

    expect(completed.status).toBe("completed");
    expect(completed.paymentAttempts[0]?.status).toBe("captured");
    expect(completed.liveSession?.customerVideoEnabled).toBe(false);
  });

  it("keeps the request active and avoids duplicate SMS alerts on retry", async () => {
    const sendOwnerAlert = vi.fn(async () => {
      throw new Error("sms unavailable");
    });
    const service = buildService({ sendOwnerAlert });

    const pending = await service.createPendingRequest({
      clientRequestId: randomUUID(),
      amountCents: 500,
      customerPhoneRaw: null,
      provider: "stripe",
      paymentMethodType: "card"
    });

    const active = await service.confirmAuthorizedPayment({
      requestId: pending.id,
      provider: "stripe",
      paymentMethodType: "card",
      externalPaymentId: `pi_${randomUUID()}`,
      authorizationId: `pi_${randomUUID()}`,
      idempotencyKey: randomUUID(),
      customerRequestedVideo: false
    });

    expect(active.status).toBe("calling");
    expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
    expect(sendOwnerAlert).toHaveBeenCalledWith({
      requestId: active.id,
      amountCents: active.amountCents
    });

    const retried = await service.confirmAuthorizedPayment({
      requestId: pending.id,
      provider: "stripe",
      paymentMethodType: "card",
      externalPaymentId: `pi_${randomUUID()}`,
      authorizationId: `pi_${randomUUID()}`,
      idempotencyKey: randomUUID(),
      customerRequestedVideo: false
    });

    expect(retried.id).toBe(active.id);
    expect(retried.status).toBe("calling");
    expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
  });

  it("allows the customer to join with video off", async () => {
    const service = buildService();
    const request = await createAuthorizedRequest(service, { customerRequestedVideo: false });

    const updated = await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      participantIdentity: request.liveSession?.customerIdentity
    });

    expect(updated.liveSession?.customerConnected).toBe(true);
    expect(updated.liveSession?.customerRequestedVideo).toBe(false);
    expect(updated.liveSession?.customerVideoEnabled).toBe(false);
    expect(updated.status).toBe("calling");
  });

  it("allows the customer to mute audio without auto-failing the session", async () => {
    const service = buildService();
    const request = await createAuthorizedRequest(service, { customerRequestedVideo: true });

    await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      participantIdentity: request.liveSession?.customerIdentity
    });

    await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      participantIdentity: request.liveSession?.ownerIdentity
    });

    const updated = await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "track-disabled",
      participantIdentity: request.liveSession?.customerIdentity,
      trackKind: "audio"
    });

    expect(updated.status).toBe("answered");
    expect(updated.paymentAttempts[0]?.status).toBe("authorized");
    expect(updated.liveSession?.customerAudioMuted).toBe(true);
  });

  it("does not charge when the live call disconnects before completion", async () => {
    const service = buildService();
    const request = await createAuthorizedRequest(service, { customerRequestedVideo: false });

    await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      participantIdentity: request.liveSession?.customerIdentity
    });

    await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-connected",
      participantIdentity: request.liveSession?.ownerIdentity
    });

    const failed = await service.handleLiveRoomEvent({
      requestId: request.id,
      statusCallbackEvent: "participant-disconnected",
      participantIdentity: request.liveSession?.customerIdentity,
      participantDuration: 19
    });

    expect(failed.status).toBe("failed");
    expect(failed.paymentAttempts[0]?.status).toBe("canceled");
    expect(failed.callAttempts[0]?.status).toBe("dropped");
  });

  it("does not charge when the owner never joins", async () => {
    const service = buildService();
    const request = await createAuthorizedRequest(service, { customerRequestedVideo: false });

    await prisma.liveSession.update({
      where: { id: request.liveSession!.id },
      data: {
        ownerJoinDeadlineAt: new Date(Date.now() - 1000)
      }
    });

    const snapshot = await service.getLiveSessionSnapshot({
      requestId: request.id,
      role: "customer",
      joinKey: request.liveSession?.customerJoinKey
    });

    expect(snapshot.requestStatus).toBe("failed");
    expect(snapshot.paymentStatus).toBe("canceled");
    expect(snapshot.liveSession.status).toBe("failed");
  });

  it("blocks new sessions while unavailable", async () => {
    const service = buildService();
    await setAvailability(false, "Closed for lunch.");

    await expect(
      service.createPendingRequest({
        clientRequestId: randomUUID(),
        amountCents: 500,
        customerPhoneRaw: null,
        provider: "stripe",
        paymentMethodType: "card"
      })
    ).rejects.toThrow("Closed for lunch.");
  });

  it("rejects amounts under fifty cents", async () => {
    const service = buildService();

    await expect(
      service.createPendingRequest({
        clientRequestId: randomUUID(),
        amountCents: 49,
        customerPhoneRaw: null,
        provider: "stripe",
        paymentMethodType: "card"
      })
    ).rejects.toThrow("Amount must be at least $0.50.");
  });
});




