import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAdminSession } from "@/src/lib/admin-session";
import { getAdminEnv } from "@/src/lib/env";

const schema = z.object({
  password: z.string().min(1)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid login request" }, { status: 400 });
    }

    if (parsed.data.password !== getAdminEnv().ADMIN_PASSWORD) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    await createAdminSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Admin login failed.", error);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
