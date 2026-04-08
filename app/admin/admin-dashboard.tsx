"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(amountCents / 100);
}

type LiveSessionSummary = {
  roomName: string;
  status: string;
  ownerConnected: boolean;
  customerConnected: boolean;
  ownerVideoEnabled: boolean;
  customerRequestedVideo: boolean;
  customerVideoEnabled: boolean;
  customerAudioEnabled: boolean;
  customerAudioMuted: boolean;
};

type RequestSummary = {
  id: string;
  amountCents: number;
  createdAt?: string;
  status: string;
  paymentAttempts: Array<{ status: string }>;
  callAttempts: Array<{ status: string }>;
  liveSession: LiveSessionSummary | null;
};

type DashboardData = {
  availability: {
    availableNow: boolean;
    label: string;
    reason: string | null;
  };
  activeRequest: RequestSummary | null;
  recentRequests: RequestSummary[];
};

async function postJson(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function describeCustomerMedia(liveSession: LiveSessionSummary | null) {
  if (!liveSession) {
    return "No live room yet";
  }

  if (!liveSession.customerConnected) {
    return liveSession.customerRequestedVideo ? "Plans video" : "Plans audio only";
  }

  if (liveSession.customerVideoEnabled) {
    return liveSession.customerAudioMuted ? "Video on, mic muted" : "Video on, audio live";
  }

  return liveSession.customerAudioMuted ? "Audio only, mic muted" : "Audio only";
}

export function AdminDashboard({ initialData }: { initialData: DashboardData }) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function refreshData() {
    const response = await fetch("/api/admin/dashboard", { cache: "no-store" });
    const payload = await response.json();
    if (response.ok) {
      setData(payload);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshData();
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function toggleAvailability(isAvailable: boolean) {
    setBusyAction("availability");
    setErrorMessage(null);
    setMessage(null);
    try {
      await postJson("/api/admin/availability", { isAvailable });
      await refreshData();
      setMessage(isAvailable ? "Compliments are live." : "Compliments are paused.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not update availability.");
    } finally {
      setBusyAction(null);
    }
  }

  async function markRequest(path: string) {
    if (!data.activeRequest) {
      return;
    }

    setBusyAction(path);
    setErrorMessage(null);
    setMessage(null);
    try {
      const payload = await postJson(path);
      setMessage(payload.message || "Request updated.");
      await refreshData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not update request.");
    } finally {
      setBusyAction(null);
    }
  }

  async function logout() {
    await postJson("/api/admin/logout");
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <div className="admin-grid">
      <aside className="stack">
        {message ? <div className="banner success-banner">{message}</div> : null}
        {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
        <div className="surface stack">
          <strong>Service switch</strong>
          <div className="muted">Status: {data.availability.label}</div>
          <div className="button-row">
            <button
              type="button"
              className="retro-button"
              onClick={() => toggleAvailability(true)}
              disabled={busyAction === "availability" || data.availability.availableNow}
            >
              AVAILABLE
            </button>
            <button
              type="button"
              className="retro-button"
              onClick={() => toggleAvailability(false)}
              disabled={busyAction === "availability" || !data.availability.availableNow}
            >
              UNAVAILABLE
            </button>
          </div>
          <div className="tiny muted">Use this before work or whenever you need the compliment kitchen closed fast.</div>
        </div>
        <div className="surface stack">
          <strong>Live room rules</strong>
          <div className="tiny muted">Owner joins on video by default.</div>
          <div className="tiny muted">Customer video is optional.</div>
          <div className="tiny muted">Capture only after manual completion.</div>
          <div className="tiny muted">If the session drops before completion, do not charge.</div>
        </div>
        <div className="surface stack">
          <strong>Owner</strong>
          <button type="button" className="retro-button" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>

      <section className="stack">
        <div className="surface stack">
          <strong>Active request</strong>
          {data.activeRequest ? (
            <>
              <div>Amount: {formatMoney(data.activeRequest.amountCents)}</div>
              <div>Request status: {data.activeRequest.status}</div>
              <div>Payment status: {data.activeRequest.paymentAttempts[0]?.status || "n/a"}</div>
              <div>Call status: {data.activeRequest.callAttempts[0]?.status || "n/a"}</div>
              <div>Live room: {data.activeRequest.liveSession?.status || "not created"}</div>
              <div>Customer media: {describeCustomerMedia(data.activeRequest.liveSession)}</div>
              <div className="tiny muted">
                Owner connected: {data.activeRequest.liveSession?.ownerConnected ? "yes" : "no"}. Customer connected: {data.activeRequest.liveSession?.customerConnected ? "yes" : "no"}.
              </div>
              <div className="button-row">
                {data.activeRequest.liveSession ? (
                  <Link href={`/admin/live/${data.activeRequest.id}`} className="retro-button link-button">
                    Join live session
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="retro-button"
                  onClick={() => markRequest(`/api/admin/requests/${data.activeRequest?.id}/complete`)}
                  disabled={busyAction === `/api/admin/requests/${data.activeRequest?.id}/complete`}
                >
                  Mark compliment completed
                </button>
                <button
                  type="button"
                  className="retro-button"
                  onClick={() => markRequest(`/api/admin/requests/${data.activeRequest?.id}/not-complete`)}
                  disabled={busyAction === `/api/admin/requests/${data.activeRequest?.id}/not-complete`}
                >
                  Mark not completed
                </button>
              </div>
            </>
          ) : (
            <div className="muted">No active compliment request right now.</div>
          )}
        </div>
        <div className="surface stack">
          <strong>Recent requests</strong>
          <div style={{ overflowX: "auto" }}>
            <table className="request-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Amount</th>
                  <th>Request</th>
                  <th>Payment</th>
                  <th>Call</th>
                  <th>Live room</th>
                  <th>Customer media</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRequests.map((request) => (
                  <tr key={request.id}>
                    <td>{request.createdAt ? new Date(request.createdAt).toLocaleString() : "n/a"}</td>
                    <td>{formatMoney(request.amountCents)}</td>
                    <td>{request.status}</td>
                    <td>{request.paymentAttempts[0]?.status || "n/a"}</td>
                    <td>{request.callAttempts[0]?.status || "n/a"}</td>
                    <td>{request.liveSession?.status || "n/a"}</td>
                    <td>{describeCustomerMedia(request.liveSession)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
