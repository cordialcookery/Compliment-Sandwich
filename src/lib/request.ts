import type { NextRequest } from "next/server";

export function getRequestActor(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "local-dev";
}

export async function getFormFields(request: Request) {
  const formData = await request.formData();
  const result: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    result[key] = String(value);
  }

  return result;
}
