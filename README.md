# Compliment Sandwich

Compliment Sandwich is a funny little Windows-95-looking MVP where a customer picks a price, authorizes a payment, and joins a browser-based live compliment room. The charge only happens after the owner manually marks the compliment completed. If the room fails, drops, or ends first, the app fails closed and does not charge.

## Stack

- Next.js App Router with TypeScript
- Prisma with SQLite for local development
- Stripe manual capture for cards, Apple Pay, and Google Pay
- PayPal authorize flow for Venmo
- Twilio Video rooms for the live browser session
- Vercel-ready app structure with env-based secrets

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the real credentials.
2. Copy `.env.local` to `.env` so Prisma CLI sees the same values locally.
3. Install dependencies with `npm install`.
4. Generate the Prisma client with `npm run prisma:generate`.
5. Push the SQLite schema with `npm run prisma:push`.
6. Start the app with `npm run dev`.
7. Run `npm test`.
8. Run `npm run build` before deploying.

## Required env vars

- `DATABASE_URL`
- `APP_URL`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_API_KEY_SID`
- `TWILIO_API_KEY_SECRET`
- `TWILIO_VIDEO_ROOM_TYPE`
- `LIVE_SESSION_OWNER_JOIN_DEADLINE_SECONDS`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID`
- `PAYPAL_WEBHOOK_ID`

## Live room flow

1. Customer creates a pending compliment request.
2. Customer authorizes payment with Stripe manual capture or PayPal authorize.
3. Backend creates a Twilio Video room and a `LiveSession` record.
4. Customer is redirected to `/call/[requestId]?joinKey=...`.
5. Admin sees the active request and can join `/admin/live/[requestId]`.
6. Owner joins with camera required by the browser UI.
7. Customer joins with camera optional and can mute or turn the camera on and off.
8. Owner manually marks the request completed to capture the payment.
9. If the room disconnects, the owner never joins, or the session ends before completion is marked, the authorization is canceled or voided.

## Payment safety

### Stripe

- The app creates a manual-capture PaymentIntent.
- Stripe checkout must reach `requires_capture` before the request becomes active.
- The owner must manually mark the compliment completed before capture happens.
- If the room drops or fails before that moment, the PaymentIntent is canceled.

### PayPal and Venmo

- The app creates a PayPal order with `intent: AUTHORIZE`.
- The approved order is authorized, not captured.
- The owner must manually mark the compliment completed before capture happens.
- If the room fails first, the PayPal authorization is voided.

## Live session state

The app keeps request, payment, call, and room state separate on purpose.

- `ComplimentRequest` tracks the business state like `pending`, `calling`, `answered`, `completed`, and `failed`.
- `PaymentAttempt` tracks `authorized`, `captured`, `canceled`, or `failed`.
- `CallAttempt` is still used as the top-level delivery attempt record, but now represents the browser session instead of a phone bridge.
- `LiveSession` tracks room status, owner and customer connection state, video and audio flags, join times, disconnect reason, and the customer join key.

That split keeps the fail-closed logic explicit: room creation does not charge, joining does not charge, and manual completion is still the only moment that can capture.

## Customer privacy controls

- Customer video is optional from the request page and the live room itself.
- Customer can mute and unmute the mic in the room.
- Customer can turn the camera on or off in the room.
- The owner page requires video by default, but the customer is never forced to enable camera.
- The browser room uses a customer join key so the customer gets room access without learning any owner-only admin URL.

## Owner dashboard

- Password login at `/admin/login`
- Fast AVAILABLE and UNAVAILABLE toggle
- Active request panel with payment status, call status, live room status, and customer media summary
- Join live session button
- Manual `Mark compliment completed` and `Mark not completed` actions
- Recent request list for quick triage

## Important test scenarios

- Customer joins audio-only and owner completes: payment is captured.
- Customer joins with video off: session stays valid.
- Customer mutes audio: session stays valid.
- Session disconnects before completion: no charge.
- Owner never joins before the join deadline: no charge.
- Unavailable mode: no new sessions.
- Amount below $0.50: rejected.

## Deployment notes

1. Create a Vercel project from this repo.
2. Add every `.env.example` variable to Vercel.
3. Use a production database instead of SQLite for real deployment.
4. Local development can use a direct database URL, but Vercel production should use Supabase''s pooled connection string instead of the direct `5432` host.
5. Prefer the pooled or transaction-mode Supabase Postgres URL for Prisma in production to avoid connection exhaustion.
6. Point Stripe webhooks to `/api/webhooks/stripe`.
5. Point PayPal webhooks to `/api/webhooks/paypal`.
6. Configure Twilio Video room status callbacks to hit `/api/webhooks/twilio/video` through the app-created room config.
7. Verify Apple Pay and Google Pay in Stripe for the production domain.
8. Deploy.

## Notes

- The public UI stays intentionally simple and retro.
- Only one active compliment request is allowed at a time.
- Rate limiting and client request ids protect against duplicate submits.
- Legacy Twilio voice endpoints are left in the app as disabled stubs so old phone-flow URLs fail clearly instead of silently charging.
- When in doubt, the code does not charge the customer.

