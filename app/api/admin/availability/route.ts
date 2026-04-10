import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminSession } from "@/src/lib/admin-session";
import { setAvailability } from "@/src/server/services/availability";
import { complimentService } from "@/src/server/services/compliment-service";

const schema = z.object({
  isAvailable: z.boolean(),
  ownerMessage: z.string().optional()
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!(await hasAdminSession())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = schema.parse(await request.json());
  const updated = await setAvailability(body.isAvailable, body.ownerMessage);
  if (body.isAvailable) {
    await complimentService.promoteNextQueuedRequest();
  }
  return NextResponse.json(updated);
}
