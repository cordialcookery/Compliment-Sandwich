import { requireAdminSession } from "@/src/lib/admin-session";
import { RetroWindow } from "@/src/components/retro-window";
import { complimentService } from "@/src/server/services/compliment-service";

import { AdminDashboard } from "./admin-dashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireAdminSession();
  const initialData = await complimentService.getAdminDashboardData();

  return (
    <main className="app-shell centered-shell">
      <RetroWindow title="Compliment Sandwich Control Panel" className="retro-window" toolbar={<div className="muted">Only capture after you finish the compliment.</div>}>
        <AdminDashboard initialData={JSON.parse(JSON.stringify(initialData))} />
      </RetroWindow>
    </main>
  );
}
