import { RetroWindow } from "@/src/components/retro-window";
import { LIVE_SESSION_CUSTOMER_ROLE } from "@/src/lib/live-session";

import { CallPageClient } from "./call-page-client";

export const dynamic = "force-dynamic";

export default async function CustomerCallPage({
  params,
  searchParams
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<{ joinKey?: string }>;
}) {
  const { requestId } = await params;
  const { joinKey } = await searchParams;

  return (
    <main className="app-shell centered-shell">
      <RetroWindow
        title="Compliment Sandwich Live Room"
        className="live-call-window"
        toolbar={<div className="muted">Owner video is always on. Your camera is optional.</div>}
      >
        <CallPageClient requestId={requestId} role={LIVE_SESSION_CUSTOMER_ROLE} joinKey={joinKey} />
      </RetroWindow>
    </main>
  );
}
