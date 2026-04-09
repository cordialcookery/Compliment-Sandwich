import fs from "node:fs";
import path from "node:path";

function readEnvValue(filePath: string, key: string) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));

  if (!line) {
    return undefined;
  }

  const rawValue = line.slice(key.length + 1).trim();
  return rawValue.replace(/^"|"$/g, "");
}

const rootDir = path.resolve(process.cwd());
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  readEnvValue(path.join(rootDir, ".env.local"), "DATABASE_URL") ||
  readEnvValue(path.join(rootDir, ".env"), "DATABASE_URL");

if (!databaseUrl) {
  throw new Error("Set TEST_DATABASE_URL or DATABASE_URL before running tests.");
}

process.env.DATABASE_URL = databaseUrl;
process.env.APP_URL = process.env.APP_URL || "http://localhost:3000";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "owner-password";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "super-secret-session-key-1234";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "twilio-auth-token";
process.env.TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || "SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || "twilio-api-key-secret";
process.env.TWILIO_VIDEO_ROOM_TYPE = process.env.TWILIO_VIDEO_ROOM_TYPE || "group-small";
process.env.LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS = process.env.LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS || "120";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_placeholder";
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "pk_test_placeholder";
process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "paypal-client-id";
process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "paypal-client-secret";
process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || "paypal-client-id";
process.env.PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || "paypal-webhook-id";
