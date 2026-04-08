import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAdminSession } from "@/src/lib/admin-session";
import { getServerEnv } from "@/src/lib/env";

const schema = z.object({
  password: z.string().min(1)
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = schema.parse(await request.json());

  if (body.password !== getServerEnv().ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  await createAdminSession();
  return NextResponse.json({ ok: true });
}
