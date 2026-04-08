import { cancelStripePaymentIntent, captureStripePaymentIntent } from "@/src/server/payments/stripe";
import { capturePayPalAuthorization, voidPayPalAuthorization } from "@/src/server/payments/paypal";

export type PaymentProviderName = "stripe" | "paypal";

export const paymentGateways = {
  stripe: {
    capture: captureStripePaymentIntent,
    cancel: cancelStripePaymentIntent
  },
  paypal: {
    capture: capturePayPalAuthorization,
    cancel: voidPayPalAuthorization
  }
};
