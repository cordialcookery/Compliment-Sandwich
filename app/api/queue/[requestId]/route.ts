import { NextRequest, NextResponse } from "next/server";

import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> }
) {
  try {
    const { requestId } = await context.params;
    const requestKey = request.nextUrl.searchParams.get("requestKey") || undefined;
    const accessToken = request.nextUrl.searchParams.get("accessToken") || undefined;
    const payload = await complimentService.getQueueSnapshot({ requestId, requestKey, accessToken });
    return NextResponse.json(JSON.parse(JSON.stringify(payload)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the waiting room.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
