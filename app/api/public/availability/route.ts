import { NextResponse } from "next/server";

import { getPublicAvailability } from "@/src/server/services/availability";

export const dynamic = "force-dynamic";

export async function GET() {
  const availability = await getPublicAvailability();
  return NextResponse.json(availability);
}
