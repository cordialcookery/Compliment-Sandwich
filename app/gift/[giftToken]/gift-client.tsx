"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type GiftSnapshot = {
  state: "invalid" | "ready" | "queued" | "promoting" | "unavailable" | "in_progress" | "used" | "canceled";
  message: string;
  amountCents: number | null;
  requestId: string | null;
  requestStatus: string | null;
  paymentStatus: string | null;
  giftRedemptionStatus: string | null;
  position: number | null;
  queueCount: number;
  queueMax: number;
  joinPath: string | null;
  canRedeem: boolean;
};

function formatMoney(amountCents: number | null) {
  if (amountCents === null) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

async function fetchJson<T>(path: string, options?: RequestInit) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Something went wrong.");
  }
  return payload as T;
}

export function GiftClient({ giftToken }: { giftToken: string }) {
  const [snapshot, setSnapshot] = useState<GiftSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customerRequestedVideo, setCustomerRequestedVideo] = useState(false);

  async function loadSnapshot(showErrors = true) {
    try {
      const payload = await fetchJson<GiftSnapshot>(`/api/gifts/${giftToken}`);
      setSnapshot(payload);
      setLoading(false);
      return payload;
    } catch (error) {
      setLoading(false);
      if (showErrors) {
        setErrorMessage(error instanceof Error ? error.message : "Could not load this gift link.");
      }
      return null;
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const payload = await loadSnapshot(false);
      if (cancelled || !payload) {
        return;
      }

      if (payload.state === "in_progress" && payload.joinPath) {
        window.location.href = payload.joinPath;
      }
    }

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [giftToken]);

  async function startGift() {
    setBusy(true);
    setErrorMessage(null);

    try {
      const payload = await fetchJson<{ nextStep: "join_room" | "queued"; joinPath?: string; message?: string }>(`/api/gifts/${giftToken}/redeem`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ customerRequestedVideo })
      });
      if (payload.nextStep === "join_room" && payload.joinPath) {
        window.location.href = payload.joinPath;
        return;
      }

      await loadSnapshot(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not start the compliment room.");
      await loadSnapshot(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="window-columns">
      <section className="stack">
        <p className="muted">Somebody paid to send you a compliment sandwich.</p>
        <div className="surface stack">
          <div>Amount waiting on the compliment: {formatMoney(snapshot?.amountCents ?? null)}</div>
          <div className="tiny muted">This gift stays in the paid line.</div>
          <div className="tiny muted">My camera will be on.</div>
          <div className="tiny muted">Your camera is optional.</div>
          <div className="tiny muted">You can mute your mic or keep your camera off if you want.</div>
          <div className="tiny muted">The gift is only consumed if the compliment is actually completed.</div>
        </div>
        <Link href="/" className="tiny">
          &larr; back to sandwich
        </Link>
      </section>

      <section className="stack">
        {loading ? <div className="banner">Checking this gift link...</div> : null}
        {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
        {snapshot ? <div className="banner">{snapshot.message}</div> : null}
        <div className="surface stack">
          <strong>Gift status</strong>
          {!snapshot ? <div className="muted">Loading the gifted compliment...</div> : null}
          {snapshot?.state === "ready" ? (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={customerRequestedVideo}
                  onChange={(event) => setCustomerRequestedVideo(event.target.checked)}
                  disabled={busy}
                />
                I&apos;ll probably join with my camera on
              </label>
              <button type="button" className="retro-button" onClick={startGift} disabled={busy}>
                {busy ? "Starting..." : "Start compliment room"}
              </button>
            </>
          ) : null}
          {snapshot?.state === "queued" ? (
            <>
              <div>Current position: {snapshot.position ? `#${snapshot.position}` : "checking..."}</div>
              <div>People waiting: {`${snapshot.queueCount} / ${snapshot.queueMax}`}</div>
            </>
          ) : null}
          {snapshot?.state === "in_progress" && snapshot.joinPath ? (
            <button
              type="button"
              className="retro-button"
              onClick={() => {
                window.location.href = snapshot.joinPath!;
              }}
            >
              Continue to live room
            </button>
          ) : null}
          {snapshot && !["ready", "in_progress", "queued", "promoting"].includes(snapshot.state) ? (
            <button type="button" className="retro-button" onClick={() => void loadSnapshot()} disabled={busy}>
              Check again
            </button>
          ) : null}
          <div className="tiny muted">
            Current state: {snapshot?.state ?? "loading"}. Request: {snapshot?.requestStatus ?? "n/a"}. Payment: {snapshot?.paymentStatus ?? "n/a"}.
          </div>
        </div>
      </section>
    </div>
  );
}
