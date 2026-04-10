import { RetroWindow } from "@/src/components/retro-window";

import { WaitClient } from "./wait-client";

export const dynamic = "force-dynamic";

export default async function WaitPage({
  params,
  searchParams
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<{ requestKey?: string; accessToken?: string }>;
}) {
  const { requestId } = await params;
  const { requestKey, accessToken } = await searchParams;

  return (
    <main className="app-shell centered-shell">
      <RetroWindow title="Compliment Queue" toolbar={<div className="muted">One live compliment at a time. Paid requests go ahead of free ones.</div>}>
        <WaitClient requestId={requestId} requestKey={requestKey ?? ""} accessToken={accessToken ?? ""} />
      </RetroWindow>
    </main>
  );
}
