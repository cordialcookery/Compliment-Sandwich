"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrack,
  Room
} from "twilio-video";

import {
  LIVE_SESSION_CUSTOMER_ROLE,
  LIVE_SESSION_OWNER_ROLE,
  getWaitingLabel,
  type LiveSessionRole
} from "@/src/lib/live-session";

type TwilioVideoModule = typeof import("twilio-video");
type ConnectableLocalTrack = LocalAudioTrack | LocalVideoTrack;

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

const VIDEO_CONSTRAINTS = {
  width: 640,
  height: 360,
  frameRate: 24,
  facingMode: "user"
} as const;

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

function formatExactError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error) {
    const name = "name" in error && typeof error.name === "string" && error.name !== "Error"
      ? `${error.name}: `
      : "";
    return `${name}${error.message || fallbackMessage}`;
  }

  return fallbackMessage;
}

function clearContainer(container: HTMLDivElement | null) {
  if (!container) {
    return;
  }

  container.innerHTML = "";
}

function attachMediaTrack(container: HTMLDivElement | null, track: AttachableTrack, muted = false) {
  if (!container) {
    throw new Error("The media container is not ready yet.");
  }

  const sid = track.sid ?? `${track.kind}-track`;
  container.querySelectorAll(`[data-track-sid="${sid}"]`).forEach((node) => node.remove());

  const element = track.attach();
  element.setAttribute("data-track-sid", sid);
  element.setAttribute("data-track-kind", track.kind);
  element.classList.add(track.kind === "video" ? "media-element" : "media-audio");

  if (typeof HTMLMediaElement !== "undefined" && element instanceof HTMLMediaElement) {
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

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function stopLocalTracks(tracks: ConnectableLocalTrack[]) {
  tracks.forEach((track) => {
    try {
      track.stop();
      track.detach().forEach((element) => element.remove());
    } catch {
      // best-effort cleanup only
    }
  });
}

function findLocalAudioTrack(room: Room | null, localTracks: ConnectableLocalTrack[]) {
  return (
    localTracks.find((track): track is LocalAudioTrack => track.kind === "audio") ??
    (room ? Array.from(room.localParticipant.audioTracks.values())[0]?.track ?? null : null)
  );
}

function findLocalVideoTrack(room: Room | null, localTracks: ConnectableLocalTrack[]) {
  return (
    localTracks.find((track): track is LocalVideoTrack => track.kind === "video") ??
    (room ? Array.from(room.localParticipant.videoTracks.values())[0]?.track ?? null : null)
  );
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
  const twilioVideoModuleRef = useRef<TwilioVideoModule | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localAudioTrackRef = useRef<LocalAudioTrack | null>(null);
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);
  const localPreviewRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioRef = useRef<HTMLDivElement | null>(null);

  const reportRoomError = useCallback((context: string, error: unknown, fallbackMessage: string) => {
    const exactMessage = formatExactError(error, fallbackMessage);
    console.error(`[Compliment Sandwich live room][${role}] ${context}`, error);
    setErrorMessage(exactMessage);
  }, [role]);

  const loadTwilioVideo = useCallback(async () => {
    if (twilioVideoModuleRef.current) {
      return twilioVideoModuleRef.current;
    }

    if (typeof window === "undefined") {
      throw new Error("The live room can only load in a browser.");
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      throw new Error("This browser does not support live audio and video devices.");
    }

    try {
      const twilioVideo = await import("twilio-video");
      twilioVideoModuleRef.current = twilioVideo;
      return twilioVideo;
    } catch (error) {
      console.error("[Compliment Sandwich live room] Failed to load twilio-video", error);
      throw new Error("The live room library could not load. Refresh and try again.");
    }
  }, []);

  const requestVideoPermissionProbe = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported in this browser.");
    }

    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: VIDEO_CONSTRAINTS.width },
          height: { ideal: VIDEO_CONSTRAINTS.height },
          frameRate: { ideal: VIDEO_CONSTRAINTS.frameRate },
          facingMode: VIDEO_CONSTRAINTS.facingMode
        }
      });
      return true;
    } catch (error) {
      console.error(`[Compliment Sandwich live room][${role}] Camera permission request failed`, error);
      throw error;
    } finally {
      stopStream(stream);
    }
  }, [role]);

  const createVideoJoinTracks = useCallback(async (twilioVideo: TwilioVideoModule) => {
    const localTracks: ConnectableLocalTrack[] = [];

    try {
      const audioTrack = await twilioVideo.createLocalAudioTrack();
      localTracks.push(audioTrack);
    } catch (error) {
      console.error(`[Compliment Sandwich live room][${role}] Local audio track creation failed`, error);
      stopLocalTracks(localTracks);
      throw new Error(`Microphone error: ${formatExactError(error, "Unable to access the microphone.")}`);
    }

    try {
      await requestVideoPermissionProbe();
    } catch (error) {
      stopLocalTracks(localTracks);
      throw new Error(`Camera permission error: ${formatExactError(error, "Unable to access the camera.")}`);
    }

    try {
      const videoTrack = await twilioVideo.createLocalVideoTrack(VIDEO_CONSTRAINTS);
      localTracks.push(videoTrack);
      return localTracks;
    } catch (error) {
      console.error(`[Compliment Sandwich live room][${role}] Local video track creation failed`, error);
      stopLocalTracks(localTracks);
      throw new Error(`Video track error: ${formatExactError(error, "Unable to create the camera track.")}`);
    }
  }, [requestVideoPermissionProbe, role]);

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
      console.error(`[Compliment Sandwich live room][${role}] Failed to refresh session snapshot`, error);
      setLoading(false);
      if (showErrors) {
        setErrorMessage(formatExactError(error, "Unable to load live session."));
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
          try {
            if ("stop" in publication.track && typeof publication.track.stop === "function") {
              publication.track.stop();
            }
            if ("detach" in publication.track && typeof publication.track.detach === "function") {
              publication.track.detach().forEach((element) => element.remove());
            }
          } catch (error) {
            console.error(`[Compliment Sandwich live room][${role}] Failed to tear down local track`, error);
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
    try {
      attachMediaTrack(localPreviewRef.current, track, true);
      setLocalPreviewAttached(true);
    } catch (error) {
      reportRoomError("Local video attach failed", error, "Your camera preview could not be displayed.");
    }
  }

  function attachRemoteTrack(track: RemoteTrack) {
    try {
      if (track.kind === "video") {
        attachMediaTrack(remoteVideoRef.current, track as unknown as AttachableTrack);
        setRemoteVideoAttached(true);
        return;
      }

      if (track.kind === "audio") {
        attachMediaTrack(remoteAudioRef.current, track as unknown as AttachableTrack);
      }
    } catch (error) {
      reportRoomError("Remote track attach failed", error, "A participant media track could not be displayed.");
    }
  }

  function detachRemoteTrack(track: RemoteTrack) {
    try {
      if (track.kind === "audio" || track.kind === "video") {
        detachMediaTrack(track as unknown as AttachableTrack);
      }
      if (track.kind === "video") {
        setRemoteVideoAttached(false);
      }
    } catch (error) {
      reportRoomError("Remote track detach failed", error, "A participant media track could not be cleaned up.");
    }
  }

  function registerParticipant(participant: RemoteParticipant) {
    try {
      participant.tracks.forEach((publication) => {
        if (publication.track) {
          attachRemoteTrack(publication.track);
        }
      });

      participant.on("trackSubscribed", (track) => {
        try {
          if (track.kind === "video") {
            console.error(`[Compliment Sandwich live room][${role}] Remote video track subscribed`, {
              participantSid: participant.sid,
              trackSid: track.sid
            });
          }
          attachRemoteTrack(track);
          if (track.kind === "audio" || track.kind === "video") {
            track.on("enabled", () => {
              try {
                attachRemoteTrack(track);
              } catch (error) {
                reportRoomError("Remote track enable handling failed", error, "A remote media track could not be enabled.");
              }
            });
            track.on("disabled", () => {
              try {
                detachRemoteTrack(track);
              } catch (error) {
                reportRoomError("Remote track disable handling failed", error, "A remote media track could not be disabled.");
              }
            });
          }
        } catch (error) {
          reportRoomError("Remote track subscribe failed", error, "A participant media track could not be loaded.");
        }
      });

      participant.on("trackUnsubscribed", (track) => {
        try {
          detachRemoteTrack(track);
        } catch (error) {
          reportRoomError("Remote track unsubscribe failed", error, "A participant media track could not be removed.");
        }
      });
    } catch (error) {
      reportRoomError("Participant registration failed", error, "A participant could not be attached to the room.");
    }
  }

  async function joinRoom() {
    if (joining || roomRef.current || isTerminal(snapshot)) {
      return;
    }

    setJoining(true);
    setErrorMessage(null);
    setInfoMessage(null);

    const wantsVideo = role === LIVE_SESSION_OWNER_ROLE || customerVideoEnabled;
    let localTracks: ConnectableLocalTrack[] = [];

    try {
      const twilioVideo = await loadTwilioVideo();
      const tokenPayload = await fetchJson<TokenResponse>("/api/live/token", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          role,
          joinKey
        })
      });

      if (!tokenPayload?.token || !tokenPayload.roomName) {
        throw new Error("The live room token response was incomplete.");
      }

      if (wantsVideo) {
        localTracks = await createVideoJoinTracks(twilioVideo);
      }

      let room: Room;
      try {
        room = await twilioVideo.connect(tokenPayload.token, wantsVideo
          ? {
              name: tokenPayload.roomName,
              tracks: localTracks
            }
          : {
              name: tokenPayload.roomName,
              audio: true,
              video: false
            });
      } catch (error) {
        console.error(`[Compliment Sandwich live room][${role}] Room connect with ${wantsVideo ? "video" : "audio-only"} failed`, error);
        stopLocalTracks(localTracks);
        throw wantsVideo
          ? new Error(`Video join failed: ${formatExactError(error, "Unable to connect with camera enabled.")}`)
          : error;
      }

      roomRef.current = room;
      setRoomConnected(true);

      const nextAudioTrack = findLocalAudioTrack(room, localTracks);
      const nextVideoTrack = findLocalVideoTrack(room, localTracks);

      localAudioTrackRef.current = nextAudioTrack;
      localVideoTrackRef.current = nextVideoTrack;
      setAudioMuted(Boolean(nextAudioTrack && nextAudioTrack.isEnabled === false));

      if (wantsVideo && !nextVideoTrack) {
        throw new Error("The room connected but no local video track was available.");
      }

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
        try {
          registerParticipant(participant);
        } catch (error) {
          reportRoomError("Participant connect handling failed", error, "A participant could not join cleanly.");
        }
      });

      room.on("participantDisconnected", (participant) => {
        try {
          participant.tracks.forEach((publication) => {
            if (publication.track) {
              detachRemoteTrack(publication.track);
            }
          });
          clearRemoteMedia();
          void refreshSnapshot(false);
        } catch (error) {
          reportRoomError("Participant disconnect handling failed", error, "The room had trouble handling a participant disconnect.");
        }
      });

      room.on("disconnected", (disconnectedRoom) => {
        try {
          teardownRoom(disconnectedRoom);
          void refreshSnapshot(false);
        } catch (error) {
          reportRoomError("Room disconnect handling failed", error, "The live room disconnected unexpectedly.");
        }
      });

      await refreshSnapshot(false);
    } catch (error) {
      reportRoomError(
        wantsVideo ? "Video join failed" : "Join room failed",
        error,
        role === LIVE_SESSION_OWNER_ROLE
          ? "Owner video is required to join this room."
          : wantsVideo
            ? "Unable to join the live room with camera enabled."
            : "Unable to join the live room."
      );
      stopLocalTracks(localTracks);
      teardownRoom(roomRef.current);
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

    try {
      if (audioMuted) {
        audioTrack.enable();
        setAudioMuted(false);
        return;
      }

      audioTrack.disable();
      setAudioMuted(true);
    } catch (error) {
      reportRoomError("Local audio toggle failed", error, "Your microphone could not be updated.");
    }
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

    try {
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

      const twilioVideo = await loadTwilioVideo();
      await requestVideoPermissionProbe();
      const newTrack = await twilioVideo.createLocalVideoTrack(VIDEO_CONSTRAINTS);
      await room.localParticipant.publishTrack(newTrack);
      localVideoTrackRef.current = newTrack;
      attachLocalVideo(newTrack);
      setCustomerVideoEnabled(true);
    } catch (error) {
      reportRoomError("Customer video toggle failed", error, "Unable to turn the camera on.");
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
      reportRoomError("Owner action update failed", error, "Unable to update request.");
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
