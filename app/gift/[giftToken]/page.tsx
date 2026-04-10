import { RetroWindow } from "@/src/components/retro-window";

import { GiftClient } from "./gift-client";

export const dynamic = "force-dynamic";

export default async function GiftPage({
  params
}: {
  params: Promise<{ giftToken: string }>;
}) {
  const { giftToken } = await params;

  return (
    <main className="app-shell centered-shell">
      <RetroWindow
        title="Gifted Compliment"
        toolbar={<div className="muted">My camera will be on. Your camera is optional.</div>}
      >
        <GiftClient giftToken={giftToken} />
      </RetroWindow>
    </main>
  );
}
