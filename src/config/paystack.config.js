/**
 * Paystack configuration (deprecated — kept for backward compatibility with
 * transactions created before the move to Pesapal; the webhook route is still
 * mounted, so verification of old payments must keep working).
 *
 * Values are getters so each read hits `process.env` at call time. As plain
 * properties they captured whatever the environment held at import, which meant
 * a module imported before the env file was loaded kept `undefined` for the
 * life of the process — and `crypto.createHmac('sha512', undefined)` in the
 * webhook handler throws a type error rather than anything that names the cause.
 */
export const paystackConfig = {
  get publicKey() {
    return process.env.PAYSTACK_PUBLIC_KEY;
  },
  get secretKey() {
    return process.env.PAYSTACK_SECRET_KEY;
  },

  get callbackUrl() {
    return `${process.env.FRONTEND_URL}/bookings/verify`;
  },
  get webhookUrl() {
    return `${process.env.BACKEND_URL}/api/payments/paystack/webhook`;
  },

  // ✅ ONLY CARD - Remove mobile_money to avoid M-Pesa showing up
  channels: ['card'],
};

/**
 * Validate before a request goes out, naming the variable that's missing.
 * `keys` lets the webhook path require only the secret, since it needs no URLs.
 */
export const requirePaystackConfig = (
  keys = ['PAYSTACK_SECRET_KEY', 'FRONTEND_URL', 'BACKEND_URL']
) => {
  const missing = keys.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Paystack is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing or empty (NODE_ENV=${process.env.NODE_ENV}).`
    );
  }

  return paystackConfig;
};
