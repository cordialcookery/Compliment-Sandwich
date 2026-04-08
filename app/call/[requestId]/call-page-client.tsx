"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  connect,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type Room
} from "twilio-video";

import {
  LIVE_SESSION_CUSTOMER_ROLE,
  LIVE_SESSION_OWNER_ROLE,
  getWaitingLabel,
  type LiveSessionRole
} from "@/src/lib/live-session";

type LiveSessionSnapshot = {
  requestId: string;
  amountCents: number;
  requestStatus: string;
  failureReason: string | null;
  paymentStatus: string;
  liveSession: {
    id: string;
    roomName: string;
    status: string;
    ownerConnected: boolean;
    customerConnected: boolean;
    ownerVideoEnabled: boolean;
    ownerAudioEnabled: boolean;
    customerRequestedVideo: boolean;
    customerVideoEnabled: boolean;
    customerAudioEnabled: boolean;
    customerAudioMuted: boolean;
    ownerJoinedAt: string | null;
    customerJoinedAt: string | null;
    ownerJoinDeadlineAt: string | null;
    completedAt: string | null;
    endedReason: string | null;
    joinPath: string;
  };
};

type TokenResponse = {
  token: string;
  roomName: string;
  identity: string;
  joinPath: string;
};

type LiveCallPageClientProps = {
  requestId: string;
  role: LiveSessionRole;
  joinKey?: string | null;
};

type AttachableTrack = {
  kind: string;
  attach: () => HTMLElement;
  detach: () => HTMLElement[];
  sid?: string;
};

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

async function fetchJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {})
    }
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Request failed.");
  }

  return payload as T;
}

function clearContainer(container: HTMLDivElement | null) {
  if (!container) {
    return;
  }

  container.innerHTML = "";
}

function attachMediaTrack(container: HTMLDivElement | null, track: AttachableTrack, muted = false) {
  if (!container) {
    return;
  }

  const sid = track.sid ?? `${track.kind}-track`;
  container.querySelectorAll(`[data-track-sid="${sid}"]`).forEach((node) => node.remove());

  const element = track.attach();
  element.setAttribute("data-track-sid", sid);
  element.setAttribute("data-track-kind", track.kind);
  element.classList.add(track.kind === "video" ? "media-element" : "media-audio");

  if (element instanceof HTMLMediaElement) {
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.muted = muted;
  }

  if (track.kind === "video") {
    clearContainer(container);
  }

  container.appendChild(element);
}

function detachMediaTrack(track: AttachableTrack) {
  track.detach().forEach((element) => element.remove());
}

function isTerminal(snapshot: LiveSessionSnapshot | null) {
  if (!snapshot) {
    return false;
  }

  return ["completed", "failed", "canceled"].includes(snapshot.requestStatus);
}

export function CallPageClient({ requestId, role, joinKey }: LiveCallPageClientProps) {
  const [snapshot, setSnapshot] = useState<LiveSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const [customerVideoEnabled, setCustomerVideoEnabled] = useState(false);
  const [localPreviewAttached, setLocalPreviewAttached] = useState(false);
  const [remoteVideoAttached, setRemoteVideoAttached] = useState(false);
  const [ownerActionBusy, setOwnerActionBusy] = useState<"complete" | "not-complete" | null>(null);
  const [roomConnected, setRoomConnected] = useState(false);

  const initializedCustomerMediaRef = useRef(false);
  const roomRef = useRef<Room | null>(null);
  const localAudioTrackRef = useRef<LocalAudioTrack | null>(null);
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);
  const localPreviewRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioRef = useRef<HTMLDivElement | null>(null);

  const sessionQuery = useMemo(() => {
    const params = new URLSearchParams({ role });
    if (joinKey) {
      params.set("joinKey", joinKey);
    }
    return params.toString();
  }, [joinKey, role]);

  const statusCopy = useMemo(() => {
    if (!snapshot) {
      return "Loading the live compliment room...";
    }

    if (snapshot.requestStatus === "completed") {
      return "Compliment completed. The charge only happens after the owner confirms it.";
    }

    if (snapshot.requestStatus === "failed" || snapshot.requestStatus === "canceled") {
      return snapshot.failureReason || snapshot.liveSession.endedReason || "The session ended before completion, so no charge was made.";
    }

    if (snapshot.liveSession.status === "joined") {
      return "Both sides are connected live.";
    }

    return getWaitingLabel(role, snapshot.liveSession.ownerConnected, snapshot.liveSession.customerConnected);
  }, [role, snapshot]);

  const remotePlaceholder = useMemo(() => {
    if (!snapshot) {
      return "Checking the compliment room...";
    }

    if (role === LIVE_SESSION_OWNER_ROLE) {
      if (!snapshot.liveSession.customerConnected) {
        return "Waiting for the customer to enter the room.";
      }

      return snapshot.liveSession.customerVideoEnabled
        ? "Customer video should appear here."
        : "Customer is here with audio only or has the camera turned off.";
    }

    if (!snapshot.liveSession.ownerConnected) {
      return "Waiting for the owner to join on video.";
    }

    return snapshot.liveSession.ownerVideoEnabled
      ? "Owner video should appear here."
      : "Owner video is reconnecting.";
  }, [role, snapshot]);

  const localPlaceholder = useMemo(() => {
    if (role === LIVE_SESSION_OWNER_ROLE) {
      return "Your camera preview appears here after you join. Video is required for the owner.";
    }

    if (!customerVideoEnabled) {
      return "Your camera is off. You can still join, talk, mute, and keep video optional.";
    }

    return "Your camera preview appears here after you join.";
  }, [customerVideoEnabled, role]);

  const secondaryNote = useMemo(() => {
    if (!snapshot) {
      return "";
    }

    if (role === LIVE_SESSION_OWNER_ROLE) {
      return snapshot.liveSession.customerConnected
        ? snapshot.liveSession.customerVideoEnabled
          ? "Customer joined with video enabled."
          : snapshot.liveSession.customerAudioMuted
            ? "Customer is in the room with the camera off and mic muted."
            : "Customer is in the room with the camera off."
        : "Customer has not joined yet.";
    }

    return snapshot.liveSession.ownerConnected
      ? "The owner should appear on video once the connection settles."
      : "If the owner never joins or the room drops before completion, you are not charged.";
  }, [role, snapshot]);

  async function refreshSnapshot(showErrors = true) {
    try {
      const nextSnapshot = await fetchJson<LiveSessionSnapshot>(`/api/live/session/${requestId}?${sessionQuery}`);
      setSnapshot(nextSnapshot);
      if (role === LIVE_SESSION_CUSTOMER_ROLE && !initializedCustomerMediaRef.current) {
        setCustomerVideoEnabled(nextSnapshot.liveSession.customerRequestedVideo);
        initializedCustomerMediaRef.current = true;
      }
      setLoading(false);
      return nextSnapshot;
    } catch (error) {
      setLoading(false);
      if (showErrors) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to load live session.");
      }
      return null;
    }
  }

  function clearRemoteMedia() {
    clearContainer(remoteVideoRef.current);
    clearContainer(remoteAudioRef.current);
    setRemoteVideoAttached(false);
  }

  function clearLocalPreview() {
    clearContainer(localPreviewRef.current);
    setLocalPreviewAttached(false);
  }

  function teardownRoom(room: Room | null) {
    const activeRoom = room ?? roomRef.current;
    if (activeRoom) {
      activeRoom.localParticipant.tracks.forEach((publication) => {
        if (publication.track) {
          if ("stop" in publication.track && typeof publication.track.stop === "function") {
            publication.track.stop();
          }
          if ("detach" in publication.track && typeof publication.track.detach === "function") {
            publication.track.detach().forEach((element) => element.remove());
          }
        }
      });
    }

    roomRef.current = null;
    localAudioTrackRef.current = null;
    localVideoTrackRef.current = null;
    clearLocalPreview();
    clearRemoteMedia();
    setAudioMuted(false);
    setRoomConnected(false);
  }

  function attachLocalVideo(track: LocalVideoTrack) {
    attachMediaTrack(localPreviewRef.current, track, true);
    setLocalPreviewAttached(true);
  }

  function attachRemoteTrack(track: RemoteTrack) {
    if (track.kind === "video") {
      attachMediaTrack(remoteVideoRef.current, track as unknown as AttachableTrack);
      setRemoteVideoAttached(true);
      return;
    }

    if (track.kind === "audio") {
      attachMediaTrack(remoteAudioRef.current, track as unknown as AttachableTrack);
    }
  }

  function detachRemoteTrack(track: RemoteTrack) {
    if (track.kind === "audio" || track.kind === "video") {
      detachMediaTrack(track as unknown as AttachableTrack);
    }
    if (track.kind === "video") {
      setRemoteVideoAttached(false);
    }
  }

  function registerParticipant(participant: RemoteParticipant) {
    participant.tracks.forEach((publication) => {
      if (publication.track) {
        attachRemoteTrack(publication.track);
      }
    });

    participant.on("trackSubscribed", (track) => {
      attachRemoteTrack(track);
      if (track.kind === "audio" || track.kind === "video") {
        track.on("enabled", () => attachRemoteTrack(track));
        track.on("disabled", () => detachRemoteTrack(track));
      }
    });

    participant.on("trackUnsubscribed", (track) => {
      detachRemoteTrack(track);
    });
  }

  async function joinRoom() {
    if (joining || roomRef.current || isTerminal(snapshot)) {
      return;
    }

    setJoining(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const tokenPayload = await fetchJson<TokenResponse>("/api/live/token", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          role,
          joinKey
        })
      });

      const room = await connect(tokenPayload.token, {
        name: tokenPayload.roomName,
        audio: true,
        video:
          role === LIVE_SESSION_OWNER_ROLE
            ? { width: 640, height: 360, frameRate: 24 }
            : customerVideoEnabled
              ? { width: 640, height: 360, frameRate: 24 }
              : false
      });

      roomRef.current = room;
      setRoomConnected(true);

      const nextAudioTrack = Array.from(room.localParticipant.audioTracks.values())[0]?.track ?? null;
      const nextVideoTrack = Array.from(room.localParticipant.videoTracks.values())[0]?.track ?? null;

      localAudioTrackRef.current = nextAudioTrack;
      localVideoTrackRef.current = nextVideoTrack;
      setAudioMuted(Boolean(nextAudioTrack && nextAudioTrack.isEnabled === false));

      if (nextVideoTrack) {
        attachLocalVideo(nextVideoTrack);
        if (role === LIVE_SESSION_CUSTOMER_ROLE) {
          setCustomerVideoEnabled(nextVideoTrack.isEnabled);
        }
      } else {
        clearLocalPreview();
      }

      room.participants.forEach((participant) => {
        registerParticipant(participant);
      });

      room.on("participantConnected", (participant) => {
        registerParticipant(participant);
      });

      room.on("participantDisconnected", (participant) => {
        participant.tracks.forEach((publication) => {
          if (publication.track) {
            detachRemoteTrack(publication.track);
          }
        });
        clearRemoteMedia();
        void refreshSnapshot(false);
      });

      room.on("disconnected", (disconnectedRoom) => {
        teardownRoom(disconnectedRoom);
        void refreshSnapshot(false);
      });

      await refreshSnapshot(false);
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : "Unable to join the live room.";
      setErrorMessage(
        role === LIVE_SESSION_OWNER_ROLE
          ? `Owner video is required to join. ${baseMessage}`
          : baseMessage
      );
    } finally {
      setJoining(false);
    }
  }

  function leaveRoom() {
    setInfoMessage(
      role === LIVE_SESSION_OWNER_ROLE
        ? "You left the room. If the compliment is not manually completed, the customer will not be charged."
        : "You left the room. You are not charged unless the compliment was already completed."
    );
    roomRef.current?.disconnect();
    teardownRoom(roomRef.current);
  }

  async function toggleAudio() {
    const audioTrack = localAudioTrackRef.current;
    if (!audioTrack) {
      return;
    }

    if (audioMuted) {
      audioTrack.enable();
      setAudioMuted(false);
    setRoomConnected(false);
      return;
    }

    audioTrack.disable();
    setAudioMuted(true);
  }

  async function toggleCustomerVideo() {
    if (role !== LIVE_SESSION_CUSTOMER_ROLE) {
      return;
    }

    const room = roomRef.current;
    if (!room) {
      setCustomerVideoEnabled((current) => !current);
      return;
    }

    const existingTrack = localVideoTrackRef.current;

    if (existingTrack && existingTrack.isEnabled) {
      existingTrack.disable();
      detachMediaTrack(existingTrack);
      setCustomerVideoEnabled(false);
      setLocalPreviewAttached(false);
      return;
    }

    if (existingTrack) {
      existingTrack.enable();
      attachLocalVideo(existingTrack);
      setCustomerVideoEnabled(true);
      return;
    }

    try {
      const newTrack = await createLocalVideoTrack({
        width: 640,
        height: 360,
        frameRate: 24
      });
      await room.localParticipant.publishTrack(newTrack);
      localVideoTrackRef.current = newTrack;
      attachLocalVideo(newTrack);
      setCustomerVideoEnabled(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to turn the camera on.");
    }
  }

  async function runOwnerAction(action: "complete" | "not-complete") {
    if (role !== LIVE_SESSION_OWNER_ROLE) {
      return;
    }

    setOwnerActionBusy(action);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const payload = await fetchJson<{ message?: string }>(
        `/api/admin/requests/${requestId}/${action === "complete" ? "complete" : "not-complete"}`,
        {
          method: "POST",
          body: JSON.stringify({})
        }
      );
      setInfoMessage(payload.message || "Request updated.");
      await refreshSnapshot(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to update request.");
    } finally {
      setOwnerActionBusy(null);
    }
  }

  useEffect(() => {
    let cancelled = false;

    const load = async (showErrors = true) => {
      const nextSnapshot = await refreshSnapshot(showErrors);
      if (!cancelled && nextSnapshot && isTerminal(nextSnapshot) && roomRef.current) {
        roomRef.current.disconnect();
      }
    };

    void load();

    const timer = window.setInterval(() => {
      void load(false);
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      roomRef.current?.disconnect();
      teardownRoom(roomRef.current);
    };
  }, [requestId, sessionQuery]);

  useEffect(() => {
    if (snapshot && isTerminal(snapshot) && roomRef.current) {
      roomRef.current.disconnect();
    }
  }, [snapshot]);

  return (
    <div className="call-layout">
      {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
      {infoMessage ? <div className="banner success-banner">{infoMessage}</div> : null}
      {snapshot?.requestStatus === "completed" ? (
        <div className="banner success-banner">
          Compliment completed. Payment capture only happened after manual owner confirmation.
        </div>
      ) : null}
      {snapshot && (snapshot.requestStatus === "failed" || snapshot.requestStatus === "canceled") ? (
        <div className="banner danger-banner">{snapshot.failureReason || snapshot.liveSession.endedReason || "No charge was made."}</div>
      ) : null}

      <section className="surface stack">
        <div className="status-line">
          <strong>{role === LIVE_SESSION_OWNER_ROLE ? "Owner Console" : "Customer Room"}</strong>
          <span>{statusCopy}</span>
        </div>
        <div className="tiny muted">
          {snapshot ? `Amount: ${formatMoney(snapshot.amountCents)}. Payment status: ${snapshot.paymentStatus}.` : "Loading request details..."}
        </div>
        <div className="stack tiny muted">
          {role === LIVE_SESSION_OWNER_ROLE ? (
            <>
              <div>Owner video is required by default.</div>
              <div>Owner audio should be on too.</div>
              <div>Do not mark complete until the compliment is fully delivered.</div>
            </>
          ) : (
            <>
              <div>My camera will be on.</div>
              <div>Your camera is optional.</div>
              <div>You can mute your mic or keep your camera off if you want.</div>
              <div>You are only charged if the compliment is successfully delivered.</div>
            </>
          )}
        </div>
        <div className="tiny muted">{secondaryNote}</div>

        {role === LIVE_SESSION_CUSTOMER_ROLE && !roomConnected && !isTerminal(snapshot) ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={customerVideoEnabled}
              onChange={(event) => setCustomerVideoEnabled(event.target.checked)}
              disabled={joining}
            />
            Join with my camera on
          </label>
        ) : null}

        <div className="button-row">
          {!roomConnected ? (
            <button type="button" className="retro-button" onClick={joinRoom} disabled={joining || loading || isTerminal(snapshot)}>
              {joining
                ? "Joining..."
                : role === LIVE_SESSION_OWNER_ROLE
                  ? "Join with camera on"
                  : customerVideoEnabled
                    ? "Join with camera on"
                    : "Join with camera off"}
            </button>
          ) : (
            <button type="button" className="retro-button" onClick={leaveRoom}>
              Leave session
            </button>
          )}

          {role === LIVE_SESSION_OWNER_ROLE ? (
            <Link href="/admin" className="retro-button link-button">
              Back to dashboard
            </Link>
          ) : (
            <Link href="/" className="retro-button link-button">
              Back to sandwich
            </Link>
          )}
        </div>

        {roomConnected ? (
          <div className="button-row">
            <button type="button" className="retro-button" onClick={toggleAudio}>
              {audioMuted ? "Unmute mic" : "Mute mic"}
            </button>
            {role === LIVE_SESSION_CUSTOMER_ROLE ? (
              <button type="button" className="retro-button" onClick={toggleCustomerVideo}>
                {customerVideoEnabled ? "Turn camera off" : "Turn camera on"}
              </button>
            ) : null}
          </div>
        ) : null}

        {role === LIVE_SESSION_OWNER_ROLE ? (
          <div className="button-row">
            <button
              type="button"
              className="retro-button"
              onClick={() => runOwnerAction("complete")}
              disabled={
                ownerActionBusy === "complete" ||
                snapshot?.liveSession.status !== "joined" ||
                snapshot?.requestStatus === "completed"
              }
            >
              {ownerActionBusy === "complete" ? "Capturing..." : "Mark compliment completed"}
            </button>
            <button
              type="button"
              className="retro-button"
              onClick={() => runOwnerAction("not-complete")}
              disabled={ownerActionBusy === "not-complete" || snapshot?.requestStatus === "completed"}
            >
              {ownerActionBusy === "not-complete" ? "Releasing..." : "Mark not completed"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="media-grid">
        <div className="surface stack">
          <strong>{role === LIVE_SESSION_OWNER_ROLE ? "Owner Preview" : "You"}</strong>
          <div className="media-frame" ref={localPreviewRef}>
            {!localPreviewAttached ? <div className="media-placeholder">{localPlaceholder}</div> : null}
          </div>
          <div className="tiny muted">
            {role === LIVE_SESSION_OWNER_ROLE
              ? "Join with camera on before speaking."
              : customerVideoEnabled
                ? "Camera on is optional and currently selected."
                : "Camera off is allowed. You can still talk and mute anytime."}
          </div>
        </div>

        <div className="surface stack">
          <strong>{role === LIVE_SESSION_OWNER_ROLE ? "Customer" : "Owner"}</strong>
          <div className="media-frame" ref={remoteVideoRef}>
            {!remoteVideoAttached ? <div className="media-placeholder">{remotePlaceholder}</div> : null}
          </div>
          <div ref={remoteAudioRef} className="remote-audio-shell" />
          <div className="tiny muted">
            {snapshot
              ? role === LIVE_SESSION_OWNER_ROLE
                ? snapshot.liveSession.customerConnected
                  ? snapshot.liveSession.customerVideoEnabled
                    ? "Customer is connected with video."
                    : snapshot.liveSession.customerAudioMuted
                      ? "Customer is connected with the mic muted."
                      : "Customer is connected with audio only."
                  : "Customer not connected yet."
                : snapshot.liveSession.ownerConnected
                  ? snapshot.liveSession.ownerVideoEnabled
                    ? "Owner is connected on video."
                    : "Owner video is reconnecting."
                  : "Owner not connected yet."
              : "Loading live presence..."}
          </div>
        </div>
      </section>
    </div>
  );
}




