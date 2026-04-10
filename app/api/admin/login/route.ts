import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAdminSession } from "@/src/lib/admin-session";
import { getServerEnv } from "@/src/lib/env";

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

    console.log("Entered password:", parsed.data.password);
console.log("Env password:", getServerEnv().ADMIN_PASSWORD);

if (parsed.data.password !== getServerEnv().ADMIN_PASSWORD) {
  return NextResponse.json({ error: "Invalid password" }, { status: 401 });
}

    await createAdminSession();
return NextResponse.json({ ok: true });

} catch (error) {
  console.error("Admin login failed.", error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 }
  );
}
}