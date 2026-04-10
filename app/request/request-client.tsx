"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { loadScript } from "@paypal/paypal-js";

type AvailabilityState = {
  availableNow: boolean;
  label: string;
  reason: string | null;
  canStartImmediately: boolean;
  canJoinQueue: boolean;
  hasActiveRequest: boolean;
  queueCount: number;
  queueMax: number;
};

type RequestClientProps = {
  initialAvailability: AvailabilityState;
  stripePublishableKey: string;
  paypalClientId: string | null;
  paypalEnabled: boolean;
  freeComplimentsEnabled: boolean;
};

type RequestType = "self_paid" | "gift_paid" | "self_free";

type PreparedRequestResponse = {
  request: {
    id: string;
    amountCents: number;
    status: string;
    requestType: RequestType;
    queuePriority: "paid" | "free";
  };
  nextStep?: "waiting_room";
  waitPath?: string;
  message?: string;
  emailSent?: boolean;
};

type ConfirmPaymentResponse = {
  requestId: string;
  status: string;
  nextStep: "join_room" | "share_link" | "waiting_room";
  message: string;
  joinPath?: string;
  sharePath?: string;
  waitPath?: string;
};

function createBrowserRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return Math.random().toString(36).slice(2);
}

function getFreeBrowserMarker() {
  if (typeof window === "undefined") {
    return "";
  }

  const existing = window.localStorage.getItem("compliment-sandwich-free-browser-marker");
  if (existing) {
    return existing;
  }

  const next = createBrowserRequestId();
  window.localStorage.setItem("compliment-sandwich-free-browser-marker", next);
  return next;
}

function markFreeAttemptLocally(email: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem("compliment-sandwich-free-attempt", email.trim().toLowerCase());
  document.cookie = "compliment_sandwich_free_attempted=1; path=/; max-age=31536000; SameSite=Lax";
}

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Something went wrong.");
  }

  return payload;
}

function StripeCheckoutPane({
  requestId,
  customerRequestedVideo,
  onSuccess,
  disabled,
  submitLabel
}: {
  requestId: string;
  customerRequestedVideo: boolean;
  onSuccess: (payload: ConfirmPaymentResponse) => void;
  disabled: boolean;
  submitLabel: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) {
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    const submitResult = await elements.submit();
    if (submitResult.error) {
      setSubmitting(false);
      setErrorMessage(submitResult.error.message || "Payment details need attention.");
      return;
    }

    const result = await stripe.confirmPayment({
      elements,
      redirect: "if_required"
    });

    if (result.error) {
      setSubmitting(false);
      setErrorMessage(result.error.message || "Payment confirmation failed.");
      return;
    }

    if (!result.paymentIntent?.id) {
      setSubmitting(false);
      setErrorMessage("Stripe did not return a payment intent.");
      return;
    }

    try {
      const payload = (await postJson("/api/payments/stripe/confirm", {
        requestId,
        paymentIntentId: result.paymentIntent.id,
        idempotencyKey: `confirm-${requestId}`,
        customerRequestedVideo
      })) as ConfirmPaymentResponse;
      onSuccess(payload);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to continue the compliment flow.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <PaymentElement />
      {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
      <button type="submit" className="retro-button" disabled={disabled || !stripe || !elements || submitting}>
        {submitting ? "Authorizing..." : submitLabel}
      </button>
      <div className="tiny muted">
        Cards are authorized only. Apple Pay and Google Pay appear automatically in Stripe when the browser and domain support them.
      </div>
    </form>
  );
}

function PayPalVenmoPane({
  paypalClientId,
  orderId,
  requestId,
  customerRequestedVideo,
  onSuccess,
  disabled,
  submitLabel
}: {
  paypalClientId: string;
  orderId: string;
  requestId: string;
  customerRequestedVideo: boolean;
  onSuccess: (payload: ConfirmPaymentResponse) => void;
  disabled: boolean;
  submitLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState<string | null>("Loading Venmo button...");

  useEffect(() => {
    let cancelled = false;

    async function mountButtons() {
      if (!containerRef.current) {
        return;
      }

      containerRef.current.innerHTML = "";
      setMessage("Loading Venmo button...");

      const paypal = (await loadScript({
        clientId: paypalClientId,
        components: "buttons,funding-eligibility",
        currency: "USD",
        intent: "authorize",
        ["enable-funding"]: "venmo"
      } as never)) as any;

      if (!paypal?.Buttons) {
        if (!cancelled) {
          setMessage("PayPal could not load. Try the Stripe option instead.");
        }
        return;
      }

      const buttons = paypal.Buttons({
        fundingSource: paypal.FUNDING.VENMO,
        style: {
          label: "pay",
          shape: "rect",
          height: 40,
          color: "silver"
        },
        createOrder: () => orderId,
        onApprove: async () => {
          const payload = (await postJson("/api/payments/paypal/authorize", {
            requestId,
            orderId,
            idempotencyKey: `paypal-${requestId}`,
            customerRequestedVideo
          })) as ConfirmPaymentResponse;
          onSuccess(payload);
        },
        onError: (error: unknown) => {
          if (!cancelled) {
            setMessage(error instanceof Error ? error.message : "Venmo could not finish checkout.");
          }
        }
      });

      if (!buttons.isEligible()) {
        if (!cancelled) {
          setMessage("Venmo is not available in this browser or PayPal merchant setup. Use the Stripe option if needed.");
        }
        return;
      }

      if (!cancelled) {
        setMessage(null);
        await buttons.render(containerRef.current);
      }
    }

    if (!disabled) {
      void mountButtons();
    }

    return () => {
      cancelled = true;
    };
  }, [customerRequestedVideo, disabled, onSuccess, orderId, paypalClientId, requestId]);

  return (
    <div className="stack paypal-button-shell">
      {message ? <div className="banner">{message}</div> : null}
      <div ref={containerRef} />
      <div className="tiny muted">{submitLabel}</div>
    </div>
  );
}

export function RequestClient({
  initialAvailability,
  stripePublishableKey,
  paypalClientId,
  paypalEnabled,
  freeComplimentsEnabled
}: RequestClientProps) {
  const [availability] = useState(initialAvailability);
  const [amount, setAmount] = useState("5.00");
  const [provider, setProvider] = useState<"stripe" | "paypal">("stripe");
  const [requestType, setRequestType] = useState<RequestType>("self_paid");
  const [customerRequestedVideo, setCustomerRequestedVideo] = useState(false);
  const [email, setEmail] = useState("");
  const [clientRequestId, setClientRequestId] = useState(createBrowserRequestId);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paypalOrderId, setPaypalOrderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [giftShareUrl, setGiftShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stripePromise = useMemo(() => loadStripe(stripePublishableKey), [stripePublishableKey]);

  useEffect(() => {
    if (!clientRequestId) {
      setClientRequestId(createBrowserRequestId());
    }
  }, [clientRequestId]);

  const isGift = requestType === "gift_paid";
  const isFree = requestType === "self_free";
  const selfFlowUnavailable = (requestType === "self_paid" || requestType === "self_free") && !availability.availableNow;
  const selfFlowQueueOpen = (requestType === "self_paid" || requestType === "self_free") && availability.availableNow && !availability.canStartImmediately;
  const paymentSubmitLabel = isGift
    ? provider === "paypal"
      ? "Authorize gift with Venmo"
      : "Authorize gift payment"
    : "Request compliment";

  async function prepareRequest() {
    setBusy(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    setCopied(false);
    setGiftShareUrl(null);

    try {
      if (isFree) {
        if (!freeComplimentsEnabled) {
          throw new Error("Free compliments are not configured right now.");
        }
        if (!email.trim()) {
          throw new Error("Enter an email so we can send your free access link.");
        }

        const prepared = (await postJson("/api/compliments", {
          requestType,
          clientRequestId,
          email,
          customerRequestedVideo,
          browserMarker: getFreeBrowserMarker()
        })) as PreparedRequestResponse;

        markFreeAttemptLocally(email);
        setSuccessMessage(prepared.message || "Check your email for your free compliment link.");
        if (prepared.waitPath) {
          window.location.href = prepared.waitPath;
          return;
        }
        return;
      }

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || Math.round(numericAmount * 100) < 50) {
        throw new Error("Minimum compliment price is $0.50.");
      }

      if (provider === "paypal" && !paypalEnabled) {
        throw new Error("Venmo is not configured on this deployment. Use the Stripe option instead.");
      }

      const prepared = (await postJson("/api/compliments", {
        amount,
        provider,
        paymentMethodType: provider === "paypal" ? "venmo" : "card",
        requestType,
        clientRequestId
      })) as PreparedRequestResponse;

      setRequestId(prepared.request.id);

      if (provider === "stripe") {
        const stripePayload = await postJson("/api/payments/stripe/create-intent", {
          requestId: prepared.request.id
        });
        setClientSecret((stripePayload as { clientSecret: string }).clientSecret);
        setPaypalOrderId(null);
      } else {
        const paypalPayload = await postJson("/api/payments/paypal/create-order", {
          requestId: prepared.request.id
        });
        setPaypalOrderId((paypalPayload as { orderId: string }).orderId);
        setClientSecret(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to prepare the request.");
    } finally {
      setBusy(false);
    }
  }

  function resetPreparation() {
    setRequestId(null);
    setClientSecret(null);
    setPaypalOrderId(null);
    setErrorMessage(null);
    setSuccessMessage(null);
    setGiftShareUrl(null);
    setCopied(false);
    setClientRequestId(createBrowserRequestId());
    setProvider("stripe");
    setRequestType("self_paid");
    setCustomerRequestedVideo(false);
    setEmail("");
  }

  async function copyGiftLink() {
    if (!giftShareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(giftShareUrl);
      setCopied(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not copy the gift link.");
    }
  }

  function handleAuthorizedPayment(payload: ConfirmPaymentResponse) {
    setSuccessMessage(payload.message);
    setErrorMessage(null);

    if (payload.nextStep === "join_room" && payload.joinPath) {
      window.location.href = payload.joinPath;
      return;
    }

    if (payload.nextStep === "waiting_room" && payload.waitPath) {
      window.location.href = payload.waitPath;
      return;
    }

    if (payload.nextStep === "share_link" && payload.sharePath) {
      const absoluteShareUrl = new URL(payload.sharePath, window.location.origin).toString();
      setGiftShareUrl(absoluteShareUrl);
      setCopied(false);
    }
  }

  return (
    <div className="window-columns">
      <section className="stack">
        <p className="muted">
          Hey, I&apos;m kind of short on cash, and they say you should do what you love and you&apos;ll never work a day in your life... or whatever. So I want to give you a compliment.
        </p>
        <div className="surface stack">
          <div className="payment-option-tabs">
            <button type="button" className="retro-button" data-active={requestType === "self_paid"} onClick={() => !requestId && setRequestType("self_paid")} disabled={Boolean(requestId)}>
              Get a compliment
            </button>
            <button type="button" className="retro-button" data-active={requestType === "gift_paid"} onClick={() => !requestId && setRequestType("gift_paid")} disabled={Boolean(requestId)}>
              Send a compliment
            </button>
            <button type="button" className="retro-button" data-active={requestType === "self_free"} onClick={() => !requestId && setRequestType("self_free")} disabled={Boolean(requestId)}>
              Get a free compliment
            </button>
          </div>

          {!isFree ? (
            <div className="field-row">
              <label htmlFor="amount">How much should the compliment cost?</label>
              <input
                id="amount"
                type="number"
                min="0.50"
                step="0.01"
                className="retro-input"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={busy || Boolean(requestId)}
              />
            </div>
          ) : null}

          {(requestType === "self_paid" || requestType === "self_free") ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={customerRequestedVideo}
                onChange={(event) => setCustomerRequestedVideo(event.target.checked)}
                disabled={busy || Boolean(requestId) || selfFlowUnavailable}
              />
              I&apos;ll probably join with my camera on
            </label>
          ) : null}

          {isFree ? (
            <div className="field-row">
              <label htmlFor="free-email">Email for your access link</label>
              <input
                id="free-email"
                type="email"
                className="retro-input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy || Boolean(requestId)}
                placeholder="you@example.com"
              />
            </div>
          ) : null}

          <div className="stack tiny muted">
            {!isFree ? <div>Minimum is $0.50.</div> : null}
            {requestType === "self_paid" ? <div>After payment authorization, you either go straight to the browser-based live compliment room or wait in line if someone is already being complimented.</div> : null}
            {requestType === "gift_paid" ? <div>After payment authorization, you get a shareable link for someone else.</div> : null}
            {requestType === "self_free" ? <div>Free compliments are for yourself only, limited to one per person, and sent to your email access link.</div> : null}
            {requestType === "self_free" ? <div>Paid requests always go ahead of free requests.</div> : null}
            <div>My camera will be on.</div>
            <div>{requestType === "gift_paid" ? "The recipient's camera is optional." : "Your camera is optional."}</div>
            <div>You can mute your mic or keep your camera off if you want.</div>
            <div>You are only charged if the compliment is successfully delivered.</div>
            {!isFree ? <div>If the room fails, drops, or ends before completion is marked, you are not charged.</div> : null}
            {requestType === "gift_paid" ? <div>The gift link only becomes permanently used once the compliment is actually completed.</div> : null}
          </div>

          {selfFlowUnavailable ? <div className="banner danger-banner">{availability.reason || availability.label}</div> : null}
          {selfFlowQueueOpen ? <div className="banner">{availability.reason || `One compliment is already in progress. ${availability.queueCount} / ${availability.queueMax} waiting.`}</div> : null}
          {requestType === "gift_paid" && !availability.availableNow ? <div className="banner">The live room is unavailable right now, but you can still prepare a gift link for later.</div> : null}
          {isFree && !freeComplimentsEnabled ? <div className="banner">Free compliments are not configured on this deployment right now.</div> : null}

          {!isFree ? (
            <div className="payment-option-tabs">
              <button type="button" className="retro-button" data-active={provider === "stripe"} onClick={() => !requestId && setProvider("stripe")} disabled={Boolean(requestId)}>
                Card / Apple Pay / Google Pay
              </button>
              {paypalEnabled ? (
                <button type="button" className="retro-button" data-active={provider === "paypal"} onClick={() => !requestId && setProvider("paypal")} disabled={Boolean(requestId)}>
                  Venmo
                </button>
              ) : null}
            </div>
          ) : null}

          {!paypalEnabled && !isFree ? <div className="tiny muted">Venmo is not configured on this deployment. Stripe checkout still works.</div> : null}

          {!requestId ? (
            <button type="button" className="retro-button" onClick={prepareRequest} disabled={busy || selfFlowUnavailable || (isFree && !freeComplimentsEnabled)}>
              {busy ? "Preparing..." : isFree ? "Email my free access link" : "Prepare payment"}
            </button>
          ) : (
            <div className="button-row">
              <button type="button" className="retro-button" onClick={resetPreparation} disabled={busy}>
                {giftShareUrl ? "Prepare another one" : "Start over"}
              </button>
            </div>
          )}
        </div>
        <div className="tiny muted">
          Browser privacy note: the live compliment happens inside the app. You can keep your own camera off, mute your mic, and leave at any time.
        </div>
        <Link href="/" className="tiny">
          &larr; back to sandwich
        </Link>
      </section>

      <section className="stack">
        {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
        {successMessage ? <div className="banner success-banner">{successMessage}</div> : null}
        <div className="surface stack">
          <strong>{giftShareUrl ? "Gift link ready" : isFree ? "Free link" : "Payment window"}</strong>
          {giftShareUrl ? (
            <>
              <div className="muted">Copy this link and send it to the person who should receive the compliment.</div>
              <input className="retro-input" readOnly value={giftShareUrl} aria-label="Gift share link" />
              <div className="button-row">
                <button type="button" className="retro-button" onClick={copyGiftLink}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              <div className="tiny muted">The link stays usable until a real compliment is actually completed.</div>
            </>
          ) : isFree ? (
            <div className="muted">Enter your email and we&apos;ll send your secure waiting-room link there. If the line is moving, paid requests always go ahead of free ones.</div>
          ) : (
            <>
              {!requestId ? <div className="muted">Pick an amount, choose who this is for, and prepare a payment method.</div> : null}
              {requestId && provider === "stripe" && clientSecret ? (
                <Elements stripe={stripePromise} options={{ clientSecret }}>
                  <StripeCheckoutPane
                    requestId={requestId}
                    customerRequestedVideo={requestType === "self_paid" ? customerRequestedVideo : false}
                    disabled={busy}
                    onSuccess={handleAuthorizedPayment}
                    submitLabel={paymentSubmitLabel}
                  />
                </Elements>
              ) : null}
              {requestId && provider === "paypal" && paypalEnabled && paypalOrderId && paypalClientId ? (
                <PayPalVenmoPane
                  paypalClientId={paypalClientId}
                  orderId={paypalOrderId}
                  requestId={requestId}
                  customerRequestedVideo={requestType === "self_paid" ? customerRequestedVideo : false}
                  disabled={busy}
                  onSuccess={handleAuthorizedPayment}
                  submitLabel={isGift
                    ? "Venmo authorizes the gift now, and the charge only captures if the recipient actually gets the compliment later."
                    : "Venmo authorizes now, and the charge only captures if the compliment is actually completed."}
                />
              ) : null}
              {requestId && !clientSecret && provider === "stripe" ? <div className="muted">Loading Stripe...</div> : null}
              {requestId && provider === "paypal" && paypalEnabled && !paypalOrderId ? <div className="muted">Loading Venmo...</div> : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
