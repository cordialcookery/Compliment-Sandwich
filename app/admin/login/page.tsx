import { redirect } from "next/navigation";

import { RetroWindow } from "@/src/components/retro-window";
import { hasAdminSession } from "@/src/lib/admin-session";

import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  if (await hasAdminSession()) {
    redirect("/admin");
  }

  return (
    <main className="app-shell centered-shell">
      <div className="login-wrap">
        <RetroWindow title="Owner Login">
          <LoginForm />
        </RetroWindow>
      </div>
    </main>
  );
}
