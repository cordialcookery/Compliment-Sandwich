"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type QueueSnapshot = {
  state: "queued" | "promoting" | "ready" | "expired" | "canceled" | "completed";
  message: string;
  requestId: string;
  amountCents: number;
  requestStatus: string;
  requestType: "self_paid" | "gift_paid" | "self_free";
  queuePriority: "paid" | "free";
  paymentStatus: string;
  position: number | null;
  queueCount: number;
  queueMax: number;
  joinPath: string | null;
};

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

async function loadQueueSnapshot(requestId: string, tokenQuery: string) {
  const response = await fetch(`/api/queue/${requestId}?${tokenQuery}`, {
    cache: "no-store"
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Could not load the waiting room.");
  }
  return payload as QueueSnapshot;
}

export function WaitClient({
  requestId,
  requestKey,
  accessToken
}: {
  requestId: string;
  requestKey: string;
  accessToken: string;
}) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const tokenQuery = useMemo(() => {
    if (accessToken) {
      return `accessToken=${encodeURIComponent(accessToken)}`;
    }

    return `requestKey=${encodeURIComponent(requestKey)}`;
  }, [accessToken, requestKey]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const payload = await loadQueueSnapshot(requestId, tokenQuery);
        if (cancelled) {
          return;
        }
        setSnapshot(payload);
        setErrorMessage(null);
        if (payload.state === "ready" && payload.joinPath) {
          window.location.href = payload.joinPath;
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load the waiting room.");
        }
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
  }, [requestId, tokenQuery]);

  const isFree = snapshot?.requestType === "self_free";

  return (
    <div className="window-columns">
      <section className="stack">
        <p className="muted">You&apos;re in line for a compliment.</p>
        <div className="surface stack">
          <div>{isFree ? "Price: free" : `Amount on hold: ${snapshot ? formatMoney(snapshot.amountCents) : "loading..."}`}</div>
          <div className="tiny muted">We only run one live compliment at a time.</div>
          <div className="tiny muted">Twilio rooms are only created for the active compliment.</div>
          <div className="tiny muted">The room will open automatically when it is your turn.</div>
          {isFree ? (
            <div className="tiny muted">Paid requests may have less wait.</div>
          ) : (
            <div className="tiny muted">You are not charged just for waiting in line.</div>
          )}
        </div>
        <Link href="/" className="tiny">
          &larr; back to sandwich
        </Link>
      </section>

      <section className="stack">
        {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
        {snapshot ? <div className="banner">{snapshot.message}</div> : <div className="banner">Checking the line...</div>}
        <div className="surface stack">
          <strong>Queue status</strong>
          <div>Current position: {snapshot?.position ? `#${snapshot.position}` : snapshot?.state === "promoting" ? "Almost there" : "Checking..."}</div>
          <div>People waiting: {snapshot ? `${snapshot.queueCount} / ${snapshot.queueMax}` : "loading..."}</div>
          <div>Request type: {snapshot ? snapshot.requestType.replaceAll("_", " ") : "loading"}</div>
          <div>Priority: {snapshot?.queuePriority ?? "loading"}</div>
          <div>Request status: {snapshot?.requestStatus ?? "loading"}</div>
          <div>Payment status: {snapshot?.paymentStatus ?? "loading"}</div>
          {(snapshot?.state === "expired" || snapshot?.state === "canceled" || snapshot?.state === "completed") ? (
            <button type="button" className="retro-button" onClick={() => window.location.reload()}>
              Check again
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
