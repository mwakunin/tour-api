/**
 * M-Pesa (Safaricom Daraja) configuration.
 *
 * Every value is a getter, so it reads `process.env` at the moment it's used
 * rather than when this module is imported. As plain properties they froze
 * whatever the environment held at import time — a module loaded before the
 * env file was read would keep `undefined` credentials for the life of the
 * process, and nothing would throw at startup to say so.
 */

const LIVE_BASE_URL = 'https://api.safaricom.co.ke';
const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';

/**
 * Whether to talk to the live Daraja API.
 *
 * MPESA_ENV wins when set, otherwise this falls back to NODE_ENV, which is what
 * the switch used to key off exclusively. That fallback is deliberate: a
 * deployment that sets only NODE_ENV=production keeps behaving exactly as
 * before. The override exists because NODE_ENV alone couldn't express "running
 * in production mode locally, but do NOT transact against live Safaricom" —
 * set MPESA_ENV=sandbox for that.
 *
 * Note MPESA_ENV was already present in .env.production but read by nothing.
 */
const isLive = () =>
  process.env.MPESA_ENV
    ? process.env.MPESA_ENV === 'production'
    : process.env.NODE_ENV === 'production';

export const mpesaConfig = {
  get consumerKey() {
    return process.env.MPESA_CONSUMER_KEY;
  },
  get consumerSecret() {
    return process.env.MPESA_CONSUMER_SECRET;
  },
  get passkey() {
    return process.env.MPESA_PASSKEY;
  },
  get shortcode() {
    return process.env.MPESA_SHORTCODE; // Your Till Number
  },

  get environment() {
    return isLive() ? 'live' : 'sandbox';
  },

  get baseURL() {
    return isLive() ? LIVE_BASE_URL : SANDBOX_BASE_URL;
  },

  get callbackURL() {
    return `${process.env.BACKEND_URL}/api/payments/mpesa/callback`;
  },

  // Transaction type for Till Number (use 'CustomerBuyGoodsOnline' for till)
  transactionType: 'CustomerPayBillOnline',
};

/**
 * Validate before a request goes out, naming the variable that's missing.
 *
 * Without this an empty credential reaches Daraja as an empty string and comes
 * back as a generic auth failure, indistinguishable from a wrong key. An absent
 * BACKEND_URL is worse still: it silently builds
 * "undefined/api/payments/mpesa/callback", so the STK push succeeds and the
 * confirmation callback never arrives.
 */
export const requireMpesaConfig = () => {
  const missing = [
    ['MPESA_CONSUMER_KEY', process.env.MPESA_CONSUMER_KEY],
    ['MPESA_CONSUMER_SECRET', process.env.MPESA_CONSUMER_SECRET],
    ['MPESA_PASSKEY', process.env.MPESA_PASSKEY],
    ['MPESA_SHORTCODE', process.env.MPESA_SHORTCODE],
    ['BACKEND_URL', process.env.BACKEND_URL],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `M-Pesa is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing or empty (NODE_ENV=${process.env.NODE_ENV}, MPESA_ENV=${
        process.env.MPESA_ENV || '<unset>'
      }).`
    );
  }

  return mpesaConfig;
};
