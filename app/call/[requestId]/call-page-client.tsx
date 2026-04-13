"use client";

import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
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
import { trackGoogleAdsConversion } from "@/src/lib/gtag";

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

type RoomUiErrorBoundaryProps = LiveCallPageClientProps & {
  children: ReactNode;
};

type RoomUiErrorBoundaryState = {
  message: string | null;
};

type AttachableTrack = {
  kind: string;
  attach: () => HTMLElement;
  detach: (element?: HTMLElement) => HTMLElement | HTMLElement[];
  sid?: string;
};

type TrackBinding = {
  element: HTMLElement;
  sid: string;
  track: AttachableTrack;
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

function normalizeDetachedElements(elements: HTMLElement | HTMLElement[] | undefined) {
  if (!elements) {
    return [];
  }

  return Array.isArray(elements) ? elements : [elements];
}

function safeRemoveNode(node: ChildNode | null, context: string) {
  if (!node) {
    console.error("[Compliment Sandwich live room] remove skipped", {
      context,
      reason: "missing_node"
    });
    return;
  }

  const parent = node.parentNode;
  console.error("[Compliment Sandwich live room] remove start", {
    context,
    hasParent: Boolean(parent),
    parentTag: parent instanceof HTMLElement ? parent.tagName : parent?.nodeName ?? null
  });

  if (!parent) {
    console.error("[Compliment Sandwich live room] remove skipped", {
      context,
      reason: "stale_parent"
    });
    return;
  }

  if (!parent.contains(node)) {
    console.error("[Compliment Sandwich live room] remove skipped", {
      context,
      reason: "parent_missing_child"
    });
    return;
  }

  try {
    parent.removeChild(node);
    console.error("[Compliment Sandwich live room] remove end", {
      context,
      status: "removed"
    });
  } catch (error) {
    console.error("[Compliment Sandwich live room] remove failed", error, {
      context
    });
  }
}

function clearContainer(container: HTMLDivElement | null, context: string) {
  if (!container) {
    console.error("[Compliment Sandwich live room] clear skipped", {
      context,
      reason: "missing_container"
    });
    return;
  }

  console.error("[Compliment Sandwich live room] clear start", {
    context,
    childCount: container.childNodes.length
  });

  Array.from(container.childNodes).forEach((node, index) => {
    safeRemoveNode(node, `${context} child ${index}`);
  });

  console.error("[Compliment Sandwich live room] clear end", {
    context,
    childCount: container.childNodes.length
  });
}

function attachMediaTrack(
  container: HTMLDivElement | null,
  track: AttachableTrack,
  options?: {
    bindingRef?: { current: TrackBinding | null };
    muted?: boolean;
    context?: string;
  }
) {
  const context = options?.context ?? `${track.kind} track`;
  console.error("[Compliment Sandwich live room] attach start", {
    context,
    containerReady: Boolean(container),
    kind: track.kind,
    trackSid: track.sid ?? null
  });

  if (!container) {
    throw new Error(`${context}: the media container is not ready yet.`);
  }

  const sid = track.sid ?? `${track.kind}-track`;
  const binding = options?.bindingRef?.current ?? null;

  if (
    binding &&
    binding.sid === sid &&
    binding.track === track &&
    binding.element.parentNode === container
  ) {
    console.error("[Compliment Sandwich live room] attach skipped", {
      context,
      reason: "already_attached",
      sid
    });
    return true;
  }

  if (binding) {
    detachMediaTrack(binding.track, `${context} replace existing`, {
      bindingRef: options?.bindingRef
    });
  } else {
    clearContainer(container, `${context} clear unattached leftovers`);
  }

  let element: HTMLElement;
  try {
    element = track.attach();
  } catch (error) {
    console.error("[Compliment Sandwich live room] track.attach() failed", error, {
      context,
      kind: track.kind,
      trackSid: track.sid ?? null
    });
    throw error instanceof Error ? error : new Error(`${context}: track.attach() failed.`);
  }

  element.setAttribute("data-track-sid", sid);
  element.setAttribute("data-track-kind", track.kind);
  element.classList.add(track.kind === "video" ? "media-element" : "media-audio");

  if (typeof HTMLMediaElement !== "undefined" && element instanceof HTMLMediaElement) {
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.muted = Boolean(options?.muted);
  }

  try {
    container.appendChild(element);
  } catch (error) {
    console.error("[Compliment Sandwich live room] appendChild failed", error, {
      context,
      kind: track.kind,
      trackSid: track.sid ?? null
    });
    safeRemoveNode(element, `${context} append failure cleanup`);
    throw error instanceof Error ? error : new Error(`${context}: the media element could not be attached.`);
  }

  if (options?.bindingRef) {
    options.bindingRef.current = {
      track,
      sid,
      element
    };
  }

  console.error("[Compliment Sandwich live room] attach end", {
    context,
    sid,
    parentMatchesContainer: element.parentNode === container
  });

  return true;
}

function detachMediaTrack(
  track: AttachableTrack,
  context = `${track.kind} track`,
  options?: {
    bindingRef?: { current: TrackBinding | null };
  }
) {
  const binding = options?.bindingRef?.current ?? null;

  console.error("[Compliment Sandwich live room] detach start", {
    context,
    kind: track.kind,
    trackSid: track.sid ?? null,
    hasBinding: Boolean(binding)
  });

  if (options?.bindingRef && !binding) {
    console.error("[Compliment Sandwich live room] detach skipped", {
      context,
      reason: "stale_binding"
    });
    return;
  }

  let detachedElements: HTMLElement[] = [];
  try {
    detachedElements = normalizeDetachedElements(binding ? track.detach(binding.element) : track.detach());
  } catch (error) {
    console.error("[Compliment Sandwich live room] detach failed", error, {
      context,
      trackSid: track.sid ?? null
    });
    detachedElements = binding?.element ? [binding.element] : [];
  }

  detachedElements.forEach((element, index) => {
    safeRemoveNode(element, `${context} detached ${index}`);
  });

  if (options?.bindingRef && options.bindingRef.current?.track === track) {
    options.bindingRef.current = null;
  }

  console.error("[Compliment Sandwich live room] detach end", {
    context,
    detachedCount: detachedElements.length
  });
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
      detachMediaTrack(track as unknown as AttachableTrack, `stopLocalTracks ${track.kind}`);
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

function RoomCrashFallback({ role, message }: { role: LiveSessionRole; message: string }) {
  return (
    <div className="call-layout">
      <div className="banner danger-banner">{message}</div>
      <section className="surface stack">
        <div className="status-line">
          <strong>{role === LIVE_SESSION_OWNER_ROLE ? "Owner Console" : "Customer Room"}</strong>
          <span>Live room error</span>
        </div>
        <div className="tiny muted">
          The room hit a client-side problem. Refresh and try joining again. If the compliment is not manually completed,
          the customer will not be charged.
        </div>
        <div className="button-row">
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
      </section>
    </div>
  );
}

class RoomUiErrorBoundary extends Component<RoomUiErrorBoundaryProps, RoomUiErrorBoundaryState> {
  state: RoomUiErrorBoundaryState = {
    message: null
  };

  static getDerivedStateFromError(error: unknown): RoomUiErrorBoundaryState {
    return {
      message: formatExactError(error, "The live room crashed before it could finish rendering.")
    };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error(
      `[Compliment Sandwich live room][${this.props.role}] Room UI error boundary caught an error`,
      error,
      {
        componentStack: errorInfo.componentStack,
        joinKeyPresent: Boolean(this.props.joinKey),
        requestId: this.props.requestId,
        stack: error instanceof Error ? error.stack : undefined
      }
    );
  }

  render() {
    if (this.state.message) {
      return <RoomCrashFallback role={this.props.role} message={this.state.message} />;
    }

    return this.props.children;
  }
}

export function CallPageClient(props: LiveCallPageClientProps) {
  return (
    <RoomUiErrorBoundary key={`${props.role}:${props.requestId}:${props.joinKey ?? "no-join-key"}`} {...props}>
      <CallPageClientInner {...props} />
    </RoomUiErrorBoundary>
  );
}

function CallPageClientInner({ requestId, role, joinKey }: LiveCallPageClientProps) {
  const [snapshot, setSnapshot] = useState<LiveSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const [customerVideoEnabled, setCustomerVideoEnabled] = useState(false);
  const [localPreviewAttached, setLocalPreviewAttached] = useState(false);
  const [localPreviewTrack, setLocalPreviewTrack] = useState<LocalVideoTrack | null>(null);
  const [remoteVideoAttached, setRemoteVideoAttached] = useState(false);
  const [ownerActionBusy, setOwnerActionBusy] = useState<"complete" | "not-complete" | null>(null);
  const [roomConnected, setRoomConnected] = useState(false);

  const mountedRef = useRef(false);
  const initializedCustomerMediaRef = useRef(false);
  const twilioVideoModuleRef = useRef<TwilioVideoModule | null>(null);
  const roomRef = useRef<Room | null>(null);
  const localAudioTrackRef = useRef<LocalAudioTrack | null>(null);
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);
  const localPreviewRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioRef = useRef<HTMLDivElement | null>(null);
  const localPreviewBindingRef = useRef<TrackBinding | null>(null);
  const remoteVideoBindingRef = useRef<TrackBinding | null>(null);
  const remoteAudioBindingRef = useRef<TrackBinding | null>(null);

  const reportRoomError = useCallback((context: string, error: unknown, fallbackMessage: string) => {
    const exactMessage = formatExactError(error, fallbackMessage);
    console.error(`[Compliment Sandwich live room][${role}] ${context}`, error);
    if (mountedRef.current) {
      setErrorMessage(exactMessage);
    }
  }, [role]);

  const renderDiagnostics = {
    audioMuted,
    customerVideoEnabled,
    errorMessage,
    hasSnapshot: Boolean(snapshot),
    infoMessage,
    joining,
    loading,
    localPreviewAttached,
    remoteVideoAttached,
    requestId,
    requestStatus: snapshot?.requestStatus ?? null,
    role,
    roomConnected,
    roomStatus: snapshot?.liveSession.status ?? null
  };

  function computeRenderValue<T>(context: string, fallbackValue: T, compute: () => T) {
    try {
      return compute();
    } catch (error) {
      console.error(`[Compliment Sandwich live room][${role}] Render compute failed: ${context}`, error, renderDiagnostics);
      return fallbackValue;
    }
  }

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
    return computeRenderValue("statusCopy", "Live room status unavailable.", () => {
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
    });
  }, [role, snapshot]);

  const remotePlaceholder = useMemo(() => {
    return computeRenderValue("remotePlaceholder", "Checking the compliment room...", () => {
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
    });
  }, [role, snapshot]);

  const localPlaceholder = useMemo(() => {
    return computeRenderValue("localPlaceholder", "Your preview will appear here after you join.", () => {
      if (role === LIVE_SESSION_OWNER_ROLE) {
        return "Your camera preview appears here after you join. Video is required for the owner.";
      }

      if (!customerVideoEnabled) {
        return "Your camera is off. You can still join, talk, mute, and keep video optional.";
      }

      return "Your camera preview appears here after you join.";
    });
  }, [customerVideoEnabled, role]);

  const secondaryNote = useMemo(() => {
    return computeRenderValue("secondaryNote", "", () => {
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
    });
  }, [role, snapshot]);

  const amountLine = useMemo(() => {
    return computeRenderValue("amountLine", "Loading request details...", () => {
      return snapshot ? `Amount: ${formatMoney(snapshot.amountCents)}. Payment status: ${snapshot.paymentStatus}.` : "Loading request details...";
    });
  }, [snapshot]);

  const localPresenceNote = useMemo(() => {
    return computeRenderValue("localPresenceNote", "Preview unavailable.", () => {
      return role === LIVE_SESSION_OWNER_ROLE
        ? "Join with camera on before speaking."
        : customerVideoEnabled
          ? "Camera on is optional and currently selected."
          : "Camera off is allowed. You can still talk and mute anytime.";
    });
  }, [customerVideoEnabled, role]);

  const remotePresenceNote = useMemo(() => {
    return computeRenderValue("remotePresenceNote", "Loading live presence...", () => {
      if (!snapshot) {
        return "Loading live presence...";
      }

      if (role === LIVE_SESSION_OWNER_ROLE) {
        return snapshot.liveSession.customerConnected
          ? snapshot.liveSession.customerVideoEnabled
            ? "Customer is connected with video."
            : snapshot.liveSession.customerAudioMuted
              ? "Customer is connected with the mic muted."
              : "Customer is connected with audio only."
          : "Customer not connected yet.";
      }

      return snapshot.liveSession.ownerConnected
        ? snapshot.liveSession.ownerVideoEnabled
          ? "Owner is connected on video."
          : "Owner video is reconnecting."
        : "Owner not connected yet.";
    });
  }, [role, snapshot]);

  async function refreshSnapshot(showErrors = true) {
    try {
      const nextSnapshot = await fetchJson<LiveSessionSnapshot>(`/api/live/session/${requestId}?${sessionQuery}`);
      if (mountedRef.current) {
        setSnapshot(nextSnapshot);
      }
      if (mountedRef.current && role === LIVE_SESSION_CUSTOMER_ROLE && !initializedCustomerMediaRef.current) {
        setCustomerVideoEnabled(nextSnapshot.liveSession.customerRequestedVideo);
        initializedCustomerMediaRef.current = true;
      }
      if (mountedRef.current) {
        setLoading(false);
      }
      return nextSnapshot;
    } catch (error) {
      console.error(`[Compliment Sandwich live room][${role}] Failed to refresh session snapshot`, error);
      if (mountedRef.current) {
        setLoading(false);
      }
      if (mountedRef.current && showErrors) {
        setErrorMessage(formatExactError(error, "Unable to load live session."));
      }
      return null;
    }
  }

  function clearRemoteMedia(suppressState = false) {
    if (remoteVideoBindingRef.current) {
      detachMediaTrack(remoteVideoBindingRef.current.track, `${role} clear remote video`, {
        bindingRef: remoteVideoBindingRef
      });
    } else {
      clearContainer(remoteVideoRef.current, `${role} clear remote video host`);
    }

    if (remoteAudioBindingRef.current) {
      detachMediaTrack(remoteAudioBindingRef.current.track, `${role} clear remote audio`, {
        bindingRef: remoteAudioBindingRef
      });
    } else {
      clearContainer(remoteAudioRef.current, `${role} clear remote audio host`);
    }

    if (!suppressState && mountedRef.current) {
      setRemoteVideoAttached(false);
    }
  }

  function clearLocalPreview(suppressState = false) {
    if (localPreviewBindingRef.current) {
      detachMediaTrack(localPreviewBindingRef.current.track, `${role} clear local preview`, {
        bindingRef: localPreviewBindingRef
      });
    } else {
      clearContainer(localPreviewRef.current, `${role} clear local preview host`);
    }

    if (!suppressState && mountedRef.current) {
      setLocalPreviewAttached(false);
    }
  }

  function teardownRoom(room: Room | null, options?: { suppressState?: boolean }) {
    const activeRoom = room ?? roomRef.current;
    if (activeRoom) {
      activeRoom.localParticipant.tracks.forEach((publication) => {
        if (publication.track) {
          try {
            if ("stop" in publication.track && typeof publication.track.stop === "function") {
              publication.track.stop();
            }
            if ("detach" in publication.track && typeof publication.track.detach === "function") {
              const localTrack = publication.track as unknown as AttachableTrack;
              detachMediaTrack(localTrack, `${role} teardown local ${publication.track.kind}`, {
                bindingRef: localPreviewBindingRef.current?.track === localTrack ? localPreviewBindingRef : undefined
              });
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
    if (!options?.suppressState && mountedRef.current) {
      setLocalPreviewTrack(null);
    }
    clearLocalPreview(Boolean(options?.suppressState));
    clearRemoteMedia(Boolean(options?.suppressState));
    if (!options?.suppressState && mountedRef.current) {
      setAudioMuted(false);
      setRoomConnected(false);
    }
  }

  function attachLocalVideo(track: LocalVideoTrack) {
    if (!mountedRef.current) {
      console.error(`[Compliment Sandwich live room][${role}] Tried to queue local video before mount`, {
        requestId,
        trackSid: "sid" in track ? track.sid : null
      });
      return;
    }

    console.error(`[Compliment Sandwich live room][${role}] Queueing local video preview`, {
      requestId,
      trackSid: "sid" in track ? track.sid : null
    });
    setLocalPreviewTrack(track);
  }

  function attachRemoteTrack(track: RemoteTrack) {
    try {
      if (!mountedRef.current) {
        console.error(`[Compliment Sandwich live room][${role}] Skipping remote track attach before mount`, {
          kind: track.kind,
          trackSid: "sid" in track ? track.sid : null
        });
        return;
      }

      if (track.kind === "video") {
        const attached = attachMediaTrack(remoteVideoRef.current, track as unknown as AttachableTrack, {
          bindingRef: remoteVideoBindingRef,
          context: `${role} remote video`,
          muted: false
        });
        if (attached && mountedRef.current) {
          setRemoteVideoAttached(true);
        }
        return;
      }

      if (track.kind === "audio") {
        attachMediaTrack(remoteAudioRef.current, track as unknown as AttachableTrack, {
          bindingRef: remoteAudioBindingRef,
          context: `${role} remote audio`,
          muted: false
        });
      }
    } catch (error) {
      reportRoomError("Remote track attach failed", error, "A participant media track could not be displayed.");
    }
  }

  function detachRemoteTrack(track: RemoteTrack) {
    try {
      if (track.kind === "video") {
        const remoteVideoTrack = track as unknown as AttachableTrack;
        if (remoteVideoBindingRef.current?.track === remoteVideoTrack) {
          detachMediaTrack(remoteVideoTrack, `${role} remote video`, {
            bindingRef: remoteVideoBindingRef
          });
        } else {
          console.error(`[Compliment Sandwich live room][${role}] Skipping stale remote video detach`, {
            trackSid: "sid" in track ? track.sid : null
          });
        }
        if (mountedRef.current) {
          setRemoteVideoAttached(false);
        }
        return;
      }

      if (track.kind === "audio") {
        const remoteAudioTrack = track as unknown as AttachableTrack;
        if (remoteAudioBindingRef.current?.track === remoteAudioTrack) {
          detachMediaTrack(remoteAudioTrack, `${role} remote audio`, {
            bindingRef: remoteAudioBindingRef
          });
        } else {
          console.error(`[Compliment Sandwich live room][${role}] Skipping stale remote audio detach`, {
            trackSid: "sid" in track ? track.sid : null
          });
        }
      }
    } catch (error) {
      reportRoomError("Remote track detach failed", error, "A participant media track could not be cleaned up.");
    }
  }

  function registerParticipant(participant: RemoteParticipant) {
    try {
      console.error(`[Compliment Sandwich live room][${role}] Registering participant`, {
        participantSid: participant.sid,
        publications: Array.from(participant.tracks.values()).map((publication) => ({
          hasTrack: Boolean(publication.track),
          kind: publication.track?.kind ?? null,
          trackSid: publication.track?.sid ?? null
        }))
      });

      participant.tracks.forEach((publication) => {
        if (publication.track) {
          attachRemoteTrack(publication.track);
        }
      });

      participant.on("trackSubscribed", (track) => {
        try {
          console.error(`[Compliment Sandwich live room][${role}] trackSubscribed`, {
            kind: track.kind,
            participantSid: participant.sid,
            trackSid: track.sid
          });
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
          console.error(`[Compliment Sandwich live room][${role}] trackUnsubscribed`, {
            kind: track.kind,
            participantSid: participant.sid,
            trackSid: track.sid
          });
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
      if (mountedRef.current) {
        setRoomConnected(true);
      }

      const nextAudioTrack = findLocalAudioTrack(room, localTracks);
      const nextVideoTrack = findLocalVideoTrack(room, localTracks);

      localAudioTrackRef.current = nextAudioTrack;
      localVideoTrackRef.current = nextVideoTrack;
      if (mountedRef.current) {
        setAudioMuted(Boolean(nextAudioTrack && nextAudioTrack.isEnabled === false));
      }

      if (wantsVideo && !nextVideoTrack) {
        throw new Error("The room connected but no local video track was available.");
      }

      if (nextVideoTrack) {
        attachLocalVideo(nextVideoTrack);
        if (mountedRef.current && role === LIVE_SESSION_CUSTOMER_ROLE) {
          setCustomerVideoEnabled(nextVideoTrack.isEnabled);
        }
      } else {
        if (mountedRef.current) {
          setLocalPreviewTrack(null);
        }
        clearLocalPreview();
      }

      console.error(`[Compliment Sandwich live room][${role}] Mapping room participants after connect`, {
        count: room.participants.size
      });
      room.participants.forEach((participant) => {
        registerParticipant(participant);
      });

      room.on("participantConnected", (participant) => {
        try {
          console.error(`[Compliment Sandwich live room][${role}] participantConnected`, {
            participantSid: participant.sid
          });
          registerParticipant(participant);
        } catch (error) {
          reportRoomError("Participant connect handling failed", error, "A participant could not join cleanly.");
        }
      });

      room.on("participantDisconnected", (participant) => {
        try {
          console.error(`[Compliment Sandwich live room][${role}] participantDisconnected`, {
            participantSid: participant.sid
          });
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
      if (mountedRef.current) {
        setJoining(false);
      }
    }
  }

  function leaveRoom() {
    if (mountedRef.current) {
      setInfoMessage(
        role === LIVE_SESSION_OWNER_ROLE
          ? "You left the room. If the compliment is not manually completed, the customer will not be charged."
          : "You left the room. You are not charged unless the compliment was already completed."
      );
    }
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
        if (mountedRef.current) {
          setAudioMuted(false);
        }
        return;
      }

      audioTrack.disable();
      if (mountedRef.current) {
        setAudioMuted(true);
      }
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
        if (mountedRef.current) {
          setCustomerVideoEnabled(false);
          setLocalPreviewTrack(null);
          setLocalPreviewAttached(false);
        }
        return;
      }

      if (existingTrack) {
        existingTrack.enable();
        attachLocalVideo(existingTrack);
        if (mountedRef.current) {
          setCustomerVideoEnabled(true);
        }
        return;
      }

      const twilioVideo = await loadTwilioVideo();
      await requestVideoPermissionProbe();
      const newTrack = await twilioVideo.createLocalVideoTrack(VIDEO_CONSTRAINTS);
      await room.localParticipant.publishTrack(newTrack);
      localVideoTrackRef.current = newTrack;
      attachLocalVideo(newTrack);
      if (mountedRef.current) {
        setCustomerVideoEnabled(true);
      }
    } catch (error) {
      reportRoomError("Customer video toggle failed", error, "Unable to turn the camera on.");
    }
  }

  async function runOwnerAction(action: "complete" | "not-complete") {
    if (role !== LIVE_SESSION_OWNER_ROLE) {
      return;
    }

    if (mountedRef.current) {
      setOwnerActionBusy(action);
      setErrorMessage(null);
      setInfoMessage(null);
    }

    try {
      const payload = await fetchJson<{ message?: string }>(
        `/api/admin/requests/${requestId}/${action === "complete" ? "complete" : "not-complete"}`,
        {
          method: "POST",
          body: JSON.stringify({})
        }
      );
      if (mountedRef.current) {
        setInfoMessage(payload.message || "Request updated.");
      }
      await refreshSnapshot(false);
    } catch (error) {
      reportRoomError("Owner action update failed", error, "Unable to update request.");
    } finally {
      if (mountedRef.current) {
        setOwnerActionBusy(null);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleWindowError = (event: ErrorEvent) => {
      const fallbackMessage = event.message || "A live room error occurred in the browser.";
      console.error(`[Compliment Sandwich live room][${role}] Window error`, event.error ?? event, {
        requestId,
        stack: event.error instanceof Error ? event.error.stack : undefined
      });
      event.preventDefault?.();
      if (mountedRef.current) {
        setErrorMessage(formatExactError(event.error ?? new Error(fallbackMessage), fallbackMessage));
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error(`[Compliment Sandwich live room][${role}] Unhandled promise rejection`, event.reason, {
        requestId
      });
      event.preventDefault?.();
      if (mountedRef.current) {
        setErrorMessage(formatExactError(event.reason, "A live room request failed unexpectedly."));
      }
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [requestId, role]);

  useEffect(() => {
    const previewContainer = localPreviewRef.current;

    if (!localPreviewTrack) {
      clearLocalPreview();
      return;
    }

    try {
      const attached = attachMediaTrack(previewContainer, localPreviewTrack, {
        bindingRef: localPreviewBindingRef,
        context: `${role} local preview`,
        muted: true
      });
      if (mountedRef.current) {
        setLocalPreviewAttached(attached);
      }
    } catch (error) {
      reportRoomError("Local video attach failed", error, "Your camera preview could not be displayed.");
      if (mountedRef.current) {
        setLocalPreviewAttached(false);
      }
    }

    return () => {
      try {
        detachMediaTrack(localPreviewTrack, `${role} local preview cleanup`, {
          bindingRef: localPreviewBindingRef
        });
      } catch (error) {
        console.error(`[Compliment Sandwich live room][${role}] Local preview cleanup failed`, error);
      }
      clearContainer(previewContainer, `${role} local preview cleanup host`);
      if (mountedRef.current) {
        setLocalPreviewAttached(false);
      }
    };
  }, [localPreviewTrack, reportRoomError, role]);

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
      teardownRoom(roomRef.current, { suppressState: true });
    };
  }, [requestId, sessionQuery]);

  useEffect(() => {
    if (snapshot && isTerminal(snapshot) && roomRef.current) {
      roomRef.current.disconnect();
    }
  }, [snapshot]);

  useEffect(() => {
    if (role !== LIVE_SESSION_CUSTOMER_ROLE || !snapshot) {
      return;
    }

    const shouldTrackConversion =
      snapshot.requestStatus === "completed" &&
      snapshot.paymentStatus === "captured" &&
      snapshot.amountCents > 0;

    if (!shouldTrackConversion) {
      return;
    }

    trackGoogleAdsConversion({
      transactionId: snapshot.requestId
    });
  }, [role, snapshot]);


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
          {amountLine}
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
          <div className="media-frame">
            <div className="media-track-host" ref={localPreviewRef} />
            {!localPreviewAttached ? <div className="media-placeholder">{localPlaceholder}</div> : null}
          </div>
          <div className="tiny muted">{localPresenceNote}</div>
        </div>

        <div className="surface stack">
          <strong>{role === LIVE_SESSION_OWNER_ROLE ? "Customer" : "Owner"}</strong>
          <div className="media-frame">
            <div className="media-track-host" ref={remoteVideoRef} />
            {!remoteVideoAttached ? <div className="media-placeholder">{remotePlaceholder}</div> : null}
          </div>
          <div ref={remoteAudioRef} className="remote-audio-shell" />
          <div className="tiny muted">{remotePresenceNote}</div>
        </div>
      </section>
    </div>
  );
}

