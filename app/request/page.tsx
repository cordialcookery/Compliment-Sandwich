import { RetroWindow } from "@/src/components/retro-window";
import { getPublicEnv, getServerEnv } from "@/src/lib/env";
import { getPublicAvailability } from "@/src/server/services/availability";

import { RequestClient } from "./request-client";

export const dynamic = "force-dynamic";

export default async function RequestPage() {
  const availability = await getPublicAvailability();
  const env = getPublicEnv();
  const serverEnv = getServerEnv();

  return (
    <main className="app-shell centered-shell">
      <RetroWindow title="Request A Compliment">
        <RequestClient
          initialAvailability={availability}
          stripePublishableKey={env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}
          paypalClientId={env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? null}
          paypalEnabled={serverEnv.paypalEnabled}
        />
      </RetroWindow>
    </main>
  );
}
