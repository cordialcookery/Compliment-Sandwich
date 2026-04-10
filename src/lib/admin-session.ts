import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ADMIN_COOKIE_NAME } from "@/src/lib/constants";
import { getAdminEnv } from "@/src/lib/env";

type SessionPayload = {
  exp: number;
  role: "owner";
};

function signPayload(payload: SessionPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getAdminEnv().ADMIN_SESSION_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyToken(token: string | undefined) {
  if (!token) {
    return null;
  }

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", getAdminEnv().ADMIN_SESSION_SECRET)
    .update(encoded)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
  if (payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

export async function createAdminSession() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: ADMIN_COOKIE_NAME,
    value: signPayload({
      exp: Date.now() + 1000 * 60 * 60 * 12,
      role: "owner"
    }),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

export async function clearAdminSession() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: ADMIN_COOKIE_NAME,
    value: "",
    expires: new Date(0),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

export async function requireAdminSession() {
  const cookieStore = await cookies();
  const payload = verifyToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
  if (!payload) {
    redirect("/admin/login");
  }
  return payload;
}

export async function hasAdminSession() {
  const cookieStore = await cookies();
  return Boolean(verifyToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value));
}
