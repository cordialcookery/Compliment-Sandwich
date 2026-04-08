import { NextRequest, NextResponse } from "next/server";

import { hasAdminSession } from "@/src/lib/admin-session";
import {
  LIVE_SESSION_CUSTOMER_ROLE,
  LIVE_SESSION_OWNER_ROLE,
  type LiveSessionRole
} from "@/src/lib/live-session";
import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> }
) {
  try {
    const { requestId } = await context.params;
    const role = request.nextUrl.searchParams.get("role") as LiveSessionRole | null;
    const joinKey = request.nextUrl.searchParams.get("joinKey");

    if (role !== LIVE_SESSION_OWNER_ROLE && role !== LIVE_SESSION_CUSTOMER_ROLE) {
      return NextResponse.json({ error: "A valid live session role is required." }, { status: 400 });
    }

    if (role === LIVE_SESSION_OWNER_ROLE && !(await hasAdminSession())) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const snapshot = await complimentService.getLiveSessionSnapshot({
      requestId,
      role,
      joinKey
    });

    return NextResponse.json(JSON.parse(JSON.stringify(snapshot)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load live session.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
