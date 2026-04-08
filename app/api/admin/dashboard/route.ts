import { NextResponse } from "next/server";

import { hasAdminSession } from "@/src/lib/admin-session";
import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasAdminSession())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const data = await complimentService.getAdminDashboardData();
  return NextResponse.json(JSON.parse(JSON.stringify(data)));
}
