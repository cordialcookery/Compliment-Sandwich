import { NextResponse } from "next/server";

import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ giftToken: string }> }
) {
  try {
    const { giftToken } = await context.params;
    const payload = await complimentService.getGiftSnapshot(giftToken);
    return NextResponse.json(JSON.parse(JSON.stringify(payload)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load gift link.";
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
