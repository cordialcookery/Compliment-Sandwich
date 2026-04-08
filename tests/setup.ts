import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(process.cwd());
const prismaDir = path.join(rootDir, "prisma");
const sourceDb = path.join(prismaDir, "dev.db");
const testDb = path.join(prismaDir, "test.db");

process.env.DATABASE_URL = "file:./test.db";
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

if (!fs.existsSync(sourceDb)) {
  throw new Error("prisma/dev.db does not exist yet. Run `npm run prisma:push` before `npm test`.");
}

fs.copyFileSync(sourceDb, testDb);
