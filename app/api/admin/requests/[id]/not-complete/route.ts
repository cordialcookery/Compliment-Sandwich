import { NextResponse } from "next/server";

import { hasAdminSession } from "@/src/lib/admin-session";
import { complimentService } from "@/src/server/services/compliment-service";

export const dynamic = "force-dynamic";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await hasAdminSession())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const request = await complimentService.markNotCompleted(id);
    return NextResponse.json({
      request,
      message: "Compliment marked not completed. Authorization released if it existed."
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to cancel request." },
      { status }
    );
  }
}
