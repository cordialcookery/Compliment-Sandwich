# Compliment Sandwich

Compliment Sandwich is a funny little Windows-95-looking MVP where one live compliment happens at a time, a small queue keeps the line moving, and the app fails closed on money. Paid requests authorize first and only capture after manual completion. Free requests skip payments entirely but still use the same live-room and queue rules.

## Stack

- Next.js App Router with TypeScript
- Prisma with PostgreSQL in the current schema
- Stripe manual capture for cards, Apple Pay, and Google Pay
- Optional PayPal authorize flow for Venmo
- Twilio Video rooms for the live browser session
- Resend for customer access emails and optional owner alerts
- Vercel-ready app structure with env-based secrets

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the real credentials.
2. Copy `.env.local` to `.env` so Prisma CLI sees the same values locally.
3. Install dependencies with `npm install`.
4. Generate the Prisma client with `npm run prisma:generate`.
5. Push the schema with `npm run prisma:push`.
6. Start the app with `npm run dev`.
7. Run `npm run build` before deploying.

## Env vars

Required core env vars:
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
- `QUEUE_REQUEST_EXPIRATION_MINUTES`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

Optional PayPal and Venmo env vars:
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID`
- `PAYPAL_WEBHOOK_ID`

Resend env vars:
- `RESEND_API_KEY`
- `ALERT_FROM_EMAIL`
- `OWNER_ALERT_EMAIL`

Notes:
- Stripe can run without PayPal configured.
- PayPal and Venmo features require the PayPal env vars.
- Free compliments require `RESEND_API_KEY` and `ALERT_FROM_EMAIL` because the customer access link is emailed.
- Owner alerts are optional and only send when `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, and `OWNER_ALERT_EMAIL` are all present.

## Request types

The app now uses one request lifecycle with three request types:
- `self_paid`
- `gift_paid`
- `self_free`

Each request also has a queue priority:
- `paid`
- `free`

Priority rules:
- `self_paid` is `paid`
- `gift_paid` is `paid`
- `self_free` is `free`
- paid requests always go ahead of free requests
- within each tier, queued requests stay FIFO by `queuedAt`

## Unified request lifecycle

Top-level request state stays explicit and readable:
- `pending`
- `payment_authorized`
- `queued`
- `calling`
- `answered`
- `completed`
- `failed`
- `canceled`

The app still keeps request, payment, call, and room state separate on purpose:
- `ComplimentRequest` tracks business state, request type, priority, queue state, gift state, and customer access metadata.
- `PaymentAttempt` tracks `requires_payment_method`, `authorized`, `captured`, `canceled`, or `failed`.
- `CallAttempt` tracks the browser delivery attempt.
- `LiveSession` tracks room status, participant state, media flags, join times, and disconnect reasons.
- `FreeComplimentIdentity` tracks one-per-email free use and light anti-abuse metadata.

## Public flows

### Paid compliment for yourself

1. Customer picks an amount.
2. Payment is authorized first.
3. If the service is idle, the request becomes the active live room.
4. If another compliment is already live, the request joins the waiting queue.
5. If the owner marks the compliment completed, the payment captures.
6. If the room fails, disconnects, expires, or ends first, the authorization is canceled or voided.

### Paid gift compliment

1. Purchaser picks an amount and authorizes payment.
2. The app creates a gift link.
3. The recipient opens the gift link later.
4. If the owner is available and idle, the gift moves into the live room.
5. If the owner is busy but available, the redeemed gift joins the paid queue.
6. The gift is only permanently consumed when the compliment is actually completed.
7. Unavailable, failed, dropped, or not-completed attempts do not consume the gift.

### Free compliment for yourself

1. Customer enters an email address.
2. The app checks free-use limits and anti-abuse metadata.
3. No payment attempt is created.
4. The app either starts the live flow immediately or queues the request behind paid work.
5. The customer gets an emailed access link plus the in-browser waiting path.
6. The free use is only permanently consumed when the compliment is completed.
7. Failed, expired, or not-completed free requests do not burn the free use.

## Queue behavior

- Only one live compliment session runs at a time.
- Up to 5 requests can wait in line.
- The queue is server-side and authoritative.
- Twilio rooms are created only for the active request, never for queued requests.
- Paid requests always outrank free requests.
- Gift-paid requests count as paid once redeemed.
- Free requests never bypass the queue.
- Gift requests never bypass the queue once redeemed.
- Queued users remain queued if the owner flips the service to unavailable.
- No one new can join while unavailable.

Queue promotion happens after:
- owner completion
- owner mark-not-completed
- disconnect before completion
- room ended before completion
- owner no-show timeout
- queue expiration for non-gift queued requests
- payment invalidation for paid requests
- reopening availability when the queue becomes promotable again

## Waiting room and access links

- Paid self requests keep the current browser waiting-room link.
- Free self requests get an emailed customer-safe waiting-room link.
- The waiting-room API calculates the real current position server-side.
- Active live work counts ahead of queued work.
- Paid queued requests count ahead of free queued requests.
- The waiting room polls and automatically opens the live room when the request is promoted.
- Invalid access tokens are rejected.

## Free compliment anti-abuse

The app makes repeat free use difficult without turning into a giant fraud system.

Current protections:
- normalized email tracking
- dedicated `FreeComplimentIdentity` table
- signed emailed access token stored hashed in the database
- rate limiting by IP
- browser-local marker sent with free requests and stored hashed server-side
- hashed IP logging
- light-touch user-agent hash logging

Current enforcement:
- a completed free compliment blocks future free requests for that email
- an active or queued free request blocks another free request for that email
- a completed free compliment from the same browser marker is blocked
- failed, expired, or not-completed free requests may try again later

## Payment safety

### Stripe

- The app creates a manual-capture PaymentIntent.
- Stripe must reach `requires_capture` before a paid request becomes live or queued.
- Capture only happens after manual owner completion.
- Queued paid requests are not charged just for waiting.
- Failed or expired paid requests cancel the PaymentIntent.

### PayPal and Venmo

- The app creates a PayPal order with `intent: AUTHORIZE`.
- The approved order is authorized, not captured.
- Capture only happens after manual owner completion.
- Queued paid requests are not charged just for waiting.
- Failed or expired paid requests void the authorization.

### Free requests

- No payment attempt is created.
- The free request still follows the same live-room and failure rules.
- Completion marks the request done, but there is nothing to capture.

## Owner dashboard

The hidden admin flow stays the same at `/admin/login`.

The dashboard now shows:
- availability toggle
- active request
- queued requests
- request type
- queue priority
- customer email when present
- payment status summary
- gift redemption status
- whether the free-use slot is consumed
- join-live button
- mark completed
- mark not completed
- remove from line

## Tests covered in the service suite

The Vitest service tests now cover:
- immediate paid service when idle
- paid-over-free queue promotion
- FIFO ordering inside the paid tier
- gift redemption entering the queue when busy
- gift not being consumed on not-completed outcome
- free requests creating no payment attempt
- completed free requests blocking another free use for the same email
- active or queued free requests blocking duplicate free requests for the same email
- no extra Twilio room creation while requests are only waiting
- paid captures only after completion

## Deployment notes

1. Create a Vercel project from this repo.
2. Add every `.env.example` variable to Vercel.
3. Use a production database instead of SQLite for real deployment.
4. Local development can use a direct database URL, but Vercel production should use Supabase's pooled connection string instead of the direct `5432` host.
5. Prefer the pooled or transaction-mode Supabase Postgres URL for Prisma in production to avoid connection exhaustion.
6. Point Stripe webhooks to `/api/webhooks/stripe`.
7. Point PayPal webhooks to `/api/webhooks/paypal`.
8. Configure Twilio Video room status callbacks to hit `/api/webhooks/twilio/video` through the app-created room config.
9. Verify Apple Pay and Google Pay in Stripe for the production domain.
10. Verify the sender domain in Resend before expecting customer or owner emails to send.
11. Deploy.

## Notes

- The public UI stays intentionally simple and retro.
- The app supports one live compliment session at a time plus a waiting queue of up to 5 requests.
- Paid requests always go ahead of free requests.
- Gift links are only truly consumed on successful completion.
- Twilio rooms only exist for the active request.
- When in doubt, the code does not charge the customer.
