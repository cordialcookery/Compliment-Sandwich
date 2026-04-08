import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminSession } from "@/src/lib/admin-session";
import {
  LIVE_SESSION_CUSTOMER_ROLE,
  LIVE_SESSION_OWNER_ROLE
} from "@/src/lib/live-session";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.object({
  requestId: z.string().min(1),
  role: z.enum([LIVE_SESSION_OWNER_ROLE, LIVE_SESSION_CUSTOMER_ROLE]),
  joinKey: z.string().optional().nullable()
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = schema.parse(await request.json());

    if (body.role === LIVE_SESSION_OWNER_ROLE && !(await hasAdminSession())) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const token = await complimentService.createLiveSessionToken({
      requestId: body.requestId,
      role: body.role,
      joinKey: body.joinKey ?? null
    });

    return NextResponse.json(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create live session token.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
