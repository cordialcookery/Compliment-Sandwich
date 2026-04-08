import { NextResponse } from "next/server";

import { clearAdminSession } from "@/src/lib/admin-session";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearAdminSession();
  return NextResponse.json({ ok: true });
}
