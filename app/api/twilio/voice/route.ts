import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return new NextResponse(
    "<Response><Say>Compliment Sandwich moved to browser-based live sessions. Please use the web app.</Say><Hangup/></Response>",
    {
      status: 410,
      headers: {
        "Content-Type": "text/xml"
      }
    }
  );
}
