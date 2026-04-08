import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      error: "Phone destination overrides are disabled. Compliment Sandwich now uses browser-based live sessions."
    },
    { status: 410 }
  );
}
