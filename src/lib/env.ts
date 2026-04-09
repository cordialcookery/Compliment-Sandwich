import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url(),
  ADMIN_PASSWORD: z.string().min(8),
  ADMIN_SESSION_SECRET: z.string().min(16),
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().min(1).optional(),
  OWNER_DESTINATION_PHONE_E164: z.string().min(1).optional(),
  TWILIO_API_KEY_SID: z.string().min(1),
  TWILIO_API_KEY_SECRET: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  PAYPAL_CLIENT_ID: z.string().min(1).optional(),
  PAYPAL_CLIENT_SECRET: z.string().min(1).optional(),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().min(1).optional(),
  PAYPAL_WEBHOOK_ID: z.string().min(1).optional(),
  LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS: z.coerce.number().int().min(15).max(600).optional(),
  TWILIO_VIDEO_ROOM_TYPE: z.enum(["group", "group-small", "peer-to-peer", "go"]).optional()
});

const publicEnvSchema = z.object({
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: z.string().min(1).optional()
});

export function getServerEnv() {
  const env = serverEnvSchema.parse(process.env);
  const paypalEnabled = Boolean(
    env.NEXT_PUBLIC_PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
  );

  return {
    ...env,
    paypalEnabled,
    LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS: env.LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS ?? 120,
    TWILIO_VIDEO_ROOM_TYPE: env.TWILIO_VIDEO_ROOM_TYPE ?? "group-small"
  };
}

export function getPublicEnv() {
  const env = publicEnvSchema.parse(process.env);
  return {
    ...env,
    paypalEnabled: Boolean(env.NEXT_PUBLIC_PAYPAL_CLIENT_ID)
  };
}
