import Image from "next/image";
import Link from "next/link";

import { RetroWindow } from "@/src/components/retro-window";
import { StatusPill } from "@/src/components/status-pill";
import { getPublicAvailability } from "@/src/server/services/availability";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const availability = await getPublicAvailability();

  return (
    <main className="app-shell centered-shell">
      <RetroWindow
        title="Compliment Sandwich.exe"
        toolbar={
          <div className="button-row" style={{ justifyContent: "space-between" }}>
            <StatusPill tone={availability.availableNow ? "success" : "danger"}>{availability.label}</StatusPill>
            <Link href="/admin/login" className="tiny">
              owner login
            </Link>
          </div>
        }
      >
        <div className="hero-stack">
          <div className="hero-word">Compliment</div>
          <Image
            src="/sandwich-paint.svg"
            width={260}
            height={220}
            alt="A goofy sandwich drawn like old MS Paint art."
            className="sandwich-art"
            priority
          />
          <div className="hero-word">Sandwich</div>
          <div className="stack" style={{ justifyItems: "center" }}>
            {availability.reason ? <div className="banner">{availability.reason}</div> : null}
            {availability.availableNow ? (
              <Link href="/request" className="retro-button">
                I want a compliment
              </Link>
            ) : (
              <button type="button" className="retro-button" disabled>
                I want a compliment
              </button>
            )}
          </div>
        </div>
      </RetroWindow>
    </main>
  );
}
