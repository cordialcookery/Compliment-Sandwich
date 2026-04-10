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
  requestType: "self_paid" | "gift_paid" | "self_free";
  queuePriority: "paid" | "free";
  customerEmail?: string | null;
  freeUseConsumedAt?: string | null;
  giftRedemptionStatus?: string;
  queuePosition?: number;
  paymentStatusLabel?: string;
  paymentAttempts: Array<{ status: string }>;
  callAttempts: Array<{ status: string }>;
  liveSession: LiveSessionSummary | null;
};

type DashboardData = {
  availability: {
    availableNow: boolean;
    label: string;
    reason: string | null;
    queueCount: number;
    queueMax: number;
    serviceEnabled: boolean;
  };
  activeRequest: RequestSummary | null;
  queuedRequests: RequestSummary[];
  queueCount: number;
  queueMax: number;
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

function prettyRequestType(requestType: RequestSummary["requestType"]) {
  if (requestType === "gift_paid") {
    return "paid gift";
  }
  if (requestType === "self_free") {
    return "free self";
  }
  return "paid self";
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

  async function runAction(path: string, body: Record<string, unknown> = {}) {
    setBusyAction(path);
    setErrorMessage(null);
    setMessage(null);
    try {
      const payload = await postJson(path, body);
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
          <div className="tiny muted">Queue: {data.queueCount} / {data.queueMax} waiting.</div>
          <div className="button-row">
            <button type="button" className="retro-button" onClick={() => runAction("/api/admin/availability", { isAvailable: true })} disabled={busyAction === "/api/admin/availability" || data.availability.serviceEnabled}>
              AVAILABLE
            </button>
            <button type="button" className="retro-button" onClick={() => runAction("/api/admin/availability", { isAvailable: false })} disabled={busyAction === "/api/admin/availability" || !data.availability.serviceEnabled}>
              UNAVAILABLE
            </button>
          </div>
          <div className="tiny muted">Existing queued people stay queued if you switch to unavailable.</div>
        </div>
        <div className="surface stack">
          <strong>Live room rules</strong>
          <div className="tiny muted">Owner joins on video by default.</div>
          <div className="tiny muted">Customer video is optional.</div>
          <div className="tiny muted">Only one live compliment session runs at a time.</div>
          <div className="tiny muted">Paid requests always go before free requests.</div>
          <div className="tiny muted">Capture only after manual completion.</div>
        </div>
        <div className="surface stack">
          <strong>Owner</strong>
          <button type="button" className="retro-button" onClick={logout}>Log out</button>
        </div>
      </aside>

      <section className="stack">
        <div className="surface stack">
          <strong>Active request</strong>
          {data.activeRequest ? (
            <>
              <div>Type: {prettyRequestType(data.activeRequest.requestType)}</div>
              <div>Priority: {data.activeRequest.queuePriority}</div>
              <div>Amount: {data.activeRequest.requestType === "self_free" ? "free" : formatMoney(data.activeRequest.amountCents)}</div>
              <div>Email: {data.activeRequest.customerEmail || "n/a"}</div>
              <div>Request status: {data.activeRequest.status}</div>
              <div>Payment status: {data.activeRequest.paymentStatusLabel || data.activeRequest.paymentAttempts[0]?.status || "n/a"}</div>
              <div>Call status: {data.activeRequest.callAttempts[0]?.status || "n/a"}</div>
              <div>Gift status: {data.activeRequest.giftRedemptionStatus || "n/a"}</div>
              <div>Free slot consumed: {data.activeRequest.freeUseConsumedAt ? "yes" : "no"}</div>
              <div>Live room: {data.activeRequest.liveSession?.status || "not created"}</div>
              <div>Customer media: {describeCustomerMedia(data.activeRequest.liveSession)}</div>
              <div className="button-row">
                {data.activeRequest.liveSession ? <Link href={`/admin/live/${data.activeRequest.id}`} className="retro-button link-button">Join live session</Link> : null}
                <button type="button" className="retro-button" onClick={() => runAction(`/api/admin/requests/${data.activeRequest?.id}/complete`)} disabled={busyAction === `/api/admin/requests/${data.activeRequest?.id}/complete`}>
                  Mark compliment completed
                </button>
                <button type="button" className="retro-button" onClick={() => runAction(`/api/admin/requests/${data.activeRequest?.id}/not-complete`)} disabled={busyAction === `/api/admin/requests/${data.activeRequest?.id}/not-complete`}>
                  Mark not completed
                </button>
              </div>
            </>
          ) : (
            <div className="muted">No active compliment request right now.</div>
          )}
        </div>

        <div className="surface stack">
          <strong>Queued requests</strong>
          <div className="tiny muted">{data.queueCount} / {data.queueMax} waiting. Paid requests keep the front of the line over free requests.</div>
          {data.queuedRequests.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="request-table">
                <thead>
                  <tr>
                    <th>Pos</th>
                    <th>Type</th>
                    <th>Priority</th>
                    <th>Email</th>
                    <th>Amount</th>
                    <th>Payment</th>
                    <th>Gift</th>
                    <th>Free used</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.queuedRequests.map((request) => (
                    <tr key={request.id}>
                      <td>#{request.queuePosition ?? "?"}</td>
                      <td>{prettyRequestType(request.requestType)}</td>
                      <td>{request.queuePriority}</td>
                      <td>{request.customerEmail || "n/a"}</td>
                      <td>{request.requestType === "self_free" ? "free" : formatMoney(request.amountCents)}</td>
                      <td>{request.paymentStatusLabel || request.paymentAttempts[0]?.status || "n/a"}</td>
                      <td>{request.giftRedemptionStatus || "n/a"}</td>
                      <td>{request.freeUseConsumedAt ? "yes" : "no"}</td>
                      <td>
                        <button type="button" className="retro-button" onClick={() => runAction(`/api/admin/requests/${request.id}/cancel-queue`)} disabled={busyAction === `/api/admin/requests/${request.id}/cancel-queue`}>
                          Remove from line
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">No one is waiting in line.</div>
          )}
        </div>

        <div className="surface stack">
          <strong>Recent requests</strong>
          <div style={{ overflowX: "auto" }}>
            <table className="request-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Priority</th>
                  <th>Email</th>
                  <th>Amount</th>
                  <th>Request</th>
                  <th>Payment</th>
                  <th>Gift</th>
                  <th>Free used</th>
                  <th>Live room</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRequests.map((request) => (
                  <tr key={request.id}>
                    <td>{request.createdAt ? new Date(request.createdAt).toLocaleString() : "n/a"}</td>
                    <td>{prettyRequestType(request.requestType)}</td>
                    <td>{request.queuePriority}</td>
                    <td>{request.customerEmail || "n/a"}</td>
                    <td>{request.requestType === "self_free" ? "free" : formatMoney(request.amountCents)}</td>
                    <td>{request.status}</td>
                    <td>{request.paymentStatusLabel || request.paymentAttempts[0]?.status || "n/a"}</td>
                    <td>{request.giftRedemptionStatus || "n/a"}</td>
                    <td>{request.freeUseConsumedAt ? "yes" : "no"}</td>
                    <td>{request.liveSession?.status || "n/a"}</td>
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
