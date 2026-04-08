import { requireAdminSession } from "@/src/lib/admin-session";
import { RetroWindow } from "@/src/components/retro-window";
import { LIVE_SESSION_OWNER_ROLE } from "@/src/lib/live-session";

import { CallPageClient } from "../../../call/[requestId]/call-page-client";

export const dynamic = "force-dynamic";

export default async function OwnerLivePage({
  params
}: {
  params: Promise<{ requestId: string }>;
}) {
  await requireAdminSession();
  const { requestId } = await params;

  return (
    <main className="app-shell centered-shell">
      <RetroWindow
        title="Compliment Sandwich Owner Live"
        className="live-call-window"
        toolbar={<div className="muted">Join with camera on. Only capture after the compliment is fully delivered.</div>}
      >
        <CallPageClient requestId={requestId} role={LIVE_SESSION_OWNER_ROLE} />
      </RetroWindow>
    </main>
  );
}
