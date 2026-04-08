"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { loadScript } from "@paypal/paypal-js";

import { MINIMUM_AMOUNT_CENTS } from "@/src/lib/constants";

type AvailabilityState = {
  availableNow: boolean;
  label: string;
  reason: string | null;
};

type RequestClientProps = {
  initialAvailability: AvailabilityState;
  stripePublishableKey: string;
  paypalClientId: string;
};

type PreparedRequestResponse = {
  request: {
    id: string;
    amountCents: number;
    status: string;
  };
};

type ConfirmPaymentResponse = {
  requestId: string;
  status: string;
  joinPath: string;
  message: string;
};

function createBrowserRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return Math.random().toString(36).slice(2);
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
  disabled
}: {
  requestId: string;
  customerRequestedVideo: boolean;
  onSuccess: (payload: ConfirmPaymentResponse) => void;
  disabled: boolean;
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
      setErrorMessage(error instanceof Error ? error.message : "Unable to start the live compliment room.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <PaymentElement />
      {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
      <button type="submit" className="retro-button" disabled={disabled || !stripe || !elements || submitting}>
        {submitting ? "Opening room..." : "Request compliment"}
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
  disabled
}: {
  paypalClientId: string;
  orderId: string;
  requestId: string;
  customerRequestedVideo: boolean;
  onSuccess: (payload: ConfirmPaymentResponse) => void;
  disabled: boolean;
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
      <div className="tiny muted">
        Venmo depends on PayPal merchant eligibility, device support, and the customer being signed in to Venmo or PayPal.
      </div>
    </div>
  );
}

export function RequestClient({ initialAvailability, stripePublishableKey, paypalClientId }: RequestClientProps) {
  const router = useRouter();
  const [availability] = useState(initialAvailability);
  const [amount, setAmount] = useState("5.00");
  const [provider, setProvider] = useState<"stripe" | "paypal">("stripe");
  const [customerRequestedVideo, setCustomerRequestedVideo] = useState(false);
  const [clientRequestId, setClientRequestId] = useState(createBrowserRequestId);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paypalOrderId, setPaypalOrderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const stripePromise = useMemo(() => loadStripe(stripePublishableKey), [stripePublishableKey]);

  useEffect(() => {
    if (!clientRequestId) {
      setClientRequestId(createBrowserRequestId());
    }
  }, [clientRequestId]);

  async function preparePayment() {
    setBusy(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || Math.round(numericAmount * 100) < MINIMUM_AMOUNT_CENTS) {
      setBusy(false);
      setErrorMessage("Minimum compliment price is $0.50.");
      return;
    }

    try {
      const prepared = (await postJson("/api/compliments", {
        amount,
        provider,
        paymentMethodType: provider === "paypal" ? "venmo" : "card",
        clientRequestId
      })) as PreparedRequestResponse;

      setRequestId(prepared.request.id);

      if (provider === "stripe") {
        const stripePayload = await postJson("/api/payments/stripe/create-intent", {
          requestId: prepared.request.id
        });
        setClientSecret(stripePayload.clientSecret);
        setPaypalOrderId(null);
      } else {
        const paypalPayload = await postJson("/api/payments/paypal/create-order", {
          requestId: prepared.request.id
        });
        setPaypalOrderId(paypalPayload.orderId);
        setClientSecret(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to prepare payment.");
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
    setClientRequestId(createBrowserRequestId());
  }

  function handleAuthorizedPayment(payload: ConfirmPaymentResponse) {
    setSuccessMessage(payload.message);
    setErrorMessage(null);
    window.location.href = payload.joinPath;
  }

  return (
    <div className="window-columns">
      <section className="stack">
        <p className="muted">
          Hey, I&apos;m kind of short on cash, and they say you should do what you love and you&apos;ll never work a day in your life... or whatever. So I want to give you a compliment.
        </p>
        <div className="surface stack">
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
              disabled={busy || Boolean(requestId) || !availability.availableNow}
            />
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={customerRequestedVideo}
              onChange={(event) => setCustomerRequestedVideo(event.target.checked)}
              disabled={busy || Boolean(requestId) || !availability.availableNow}
            />
            I&apos;ll probably join with my camera on
          </label>
          <div className="stack tiny muted">
            <div>Minimum is $0.50.</div>
            <div>After payment authorization, you go to a browser-based live compliment room.</div>
            <div>My camera will be on.</div>
            <div>Your camera is optional.</div>
            <div>You can mute your mic or keep your camera off if you want.</div>
            <div>You are only charged if the compliment is successfully delivered.</div>
            <div>If the room fails, drops, or ends before completion is marked, you are not charged.</div>
          </div>
          <div className="payment-option-tabs">
            <button
              type="button"
              className="retro-button"
              data-active={provider === "stripe"}
              onClick={() => {
                if (!requestId) {
                  setProvider("stripe");
                }
              }}
              disabled={Boolean(requestId)}
            >
              Card / Apple Pay / Google Pay
            </button>
            <button
              type="button"
              className="retro-button"
              data-active={provider === "paypal"}
              onClick={() => {
                if (!requestId) {
                  setProvider("paypal");
                }
              }}
              disabled={Boolean(requestId)}
            >
              Venmo
            </button>
          </div>
          {!requestId ? (
            <button type="button" className="retro-button" onClick={preparePayment} disabled={busy || !availability.availableNow}>
              {busy ? "Preparing..." : "Prepare payment"}
            </button>
          ) : (
            <div className="button-row">
              <button type="button" className="retro-button" onClick={resetPreparation} disabled={busy}>
                Start over
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
        {!availability.availableNow ? <div className="banner danger-banner">{availability.reason || availability.label}</div> : null}
        {errorMessage ? <div className="banner danger-banner">{errorMessage}</div> : null}
        {successMessage ? <div className="banner success-banner">{successMessage}</div> : null}
        <div className="surface stack">
          <strong>Payment window</strong>
          {!requestId ? <div className="muted">Pick an amount, choose your camera preference, and prepare a payment method.</div> : null}
          {requestId && provider === "stripe" && clientSecret ? (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <StripeCheckoutPane
                requestId={requestId}
                customerRequestedVideo={customerRequestedVideo}
                disabled={busy}
                onSuccess={handleAuthorizedPayment}
              />
            </Elements>
          ) : null}
          {requestId && provider === "paypal" && paypalOrderId ? (
            <PayPalVenmoPane
              paypalClientId={paypalClientId}
              orderId={paypalOrderId}
              requestId={requestId}
              customerRequestedVideo={customerRequestedVideo}
              disabled={busy}
              onSuccess={handleAuthorizedPayment}
            />
          ) : null}
          {requestId && !clientSecret && provider === "stripe" ? <div className="muted">Loading Stripe...</div> : null}
          {requestId && !paypalOrderId && provider === "paypal" ? <div className="muted">Loading Venmo...</div> : null}
        </div>
      </section>
    </div>
  );
}


