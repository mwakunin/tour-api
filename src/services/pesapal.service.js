import axios from 'axios';
import crypto from 'crypto';
import logger from '#config/logger.js';
import { db } from '#config/database.js';
import { bookings } from '#models/booking.model.js';
import { payments } from '#models/payment.model.js';
import { eq } from 'drizzle-orm';
import { emailService } from './email.service.js';
import { invalidateBooking } from '#utils/cacheInvalidation.js';

const PESAPAL_LIVE_URL = 'https://pay.pesapal.com/v3';
const PESAPAL_SANDBOX_URL = 'https://cybqa.pesapal.com/pesapalv3';

/**
 * Resolve Pesapal settings at call time.
 *
 * These used to be module-scope consts, which froze whatever `process.env` held
 * at import time — so a caller that reached this module before the environment
 * was loaded would send `consumer_key: undefined` on every request, for the
 * life of the process, without anything throwing at startup.
 *
 * `live` is deliberately strict. Anything other than the exact string
 * 'production' — unset, empty, or a near-miss like 'live' — resolves to the
 * sandbox, so it must be checked explicitly rather than assumed.
 */
const pesapalConfig = () => {
  const live = process.env.PESAPAL_ENV === 'production';

  return {
    live,
    baseUrl: live ? PESAPAL_LIVE_URL : PESAPAL_SANDBOX_URL,
    consumerKey: process.env.PESAPAL_CONSUMER_KEY,
    consumerSecret: process.env.PESAPAL_CONSUMER_SECRET,
    appUrl: process.env.APP_URL,
  };
};

/**
 * Fail with the name of the missing variable rather than letting Pesapal
 * reject an empty credential as a generic auth error — the two are
 * indistinguishable from the caller's side otherwise.
 */
const requirePesapalConfig = () => {
  const config = pesapalConfig();

  const missing = [
    ['PESAPAL_CONSUMER_KEY', config.consumerKey],
    ['PESAPAL_CONSUMER_SECRET', config.consumerSecret],
    ['APP_URL', config.appUrl],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Pesapal is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing or empty (NODE_ENV=${process.env.NODE_ENV}).`
    );
  }

  return config;
};

// Token/IPN cache. Both are issued *by* a particular Pesapal environment for a
// particular merchant, so they are only valid for the configuration that
// produced them — hence `cachedFor`, a fingerprint of that configuration.
// Reading config at call time (rather than freezing it at import) is what makes
// this necessary: without the key, a token minted against sandbox could be
// replayed against the live endpoint if the environment changed mid-process.
let authToken = null;
let tokenExpiry = null;
let ipnId = null;
let cachedFor = null;
// Logged once per configuration so "are we actually live?" is answerable from
// the logs, rather than inferred from which URL happens to appear in an error.
let loggedMode = false;

// Never logged — it exists only to compare against itself.
const fingerprint = (config) =>
  `${config.baseUrl}|${config.consumerKey}|${config.appUrl}`;

/**
 * Drop anything cached under a different configuration.
 *
 * Called before every cache read, so a stale token or IPN id can't outlive the
 * settings it belongs to.
 */
function syncCacheToConfig(config) {
  const current = fingerprint(config);
  if (current === cachedFor) return;

  if (cachedFor !== null) {
    logger.warn(
      '[Pesapal] Configuration changed — discarding cached auth token and IPN id.'
    );
  }

  authToken = null;
  tokenExpiry = null;
  ipnId = null;
  loggedMode = false;
  cachedFor = current;
}

/**
 * Get Pesapal authentication token (with caching)
 *
 * Takes the resolved config rather than resolving its own, so that a single
 * request uses one consistent snapshot across token, IPN and order submission.
 */
async function getPesapalAuthToken(config) {
  const { baseUrl, consumerKey, consumerSecret, live } = config;

  // Before the cache read, not after — otherwise a token from the previous
  // configuration would be returned unchecked.
  syncCacheToConfig(config);

  if (authToken && tokenExpiry && Date.now() < tokenExpiry) {
    return authToken;
  }

  if (!loggedMode) {
    logger.info(
      `[Pesapal] Using ${live ? 'LIVE' : 'SANDBOX'} endpoint ${baseUrl}${
        live ? '' : ' — set PESAPAL_ENV=production (exact string) to go live.'
      }`
    );
    loggedMode = true;
  }

  try {
    const response = await axios.post(
      `${baseUrl}/api/Auth/RequestToken`,
      {
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    if (!response.data?.token) {
      throw new Error('Invalid token response from Pesapal');
    }

    authToken = response.data.token;
    tokenExpiry = Date.now() + 9 * 60 * 60 * 1000; // 9 hours

    logger.info('Pesapal auth token obtained');
    return authToken;
  } catch (error) {
    logger.error(
      'Failed to get Pesapal auth token:',
      error.response?.data || error.message
    );
    throw new Error('Failed to authenticate with Pesapal');
  }
}

/**
 * Register or get IPN ID
 */
async function getOrRegisterIPN(token, config) {
  const { baseUrl, appUrl } = config;

  // An IPN id is registered against one merchant/environment pair, so the same
  // key guards it. Checked before the cache read for the same reason as above.
  syncCacheToConfig(config);

  if (ipnId) return ipnId;

  try {
    const ipnUrl = `${appUrl}/api/payments/pesapal/ipn`;

    // Check existing IPNs
    const listResponse = await axios.get(`${baseUrl}/api/URLSetup/GetIpnList`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const existingIPN = listResponse.data?.find((ipn) => ipn.url === ipnUrl);
    if (existingIPN) {
      ipnId = existingIPN.ipn_id;
      logger.info('Using existing Pesapal IPN:', ipnId);
      return ipnId;
    }

    // Register new IPN
    const registerResponse = await axios.post(
      `${baseUrl}/api/URLSetup/RegisterIPN`,
      {
        url: ipnUrl,
        ipn_notification_type: 'GET',
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    ipnId = registerResponse.data.ipn_id;
    logger.info('Pesapal IPN registered:', ipnId);
    return ipnId;
  } catch (error) {
    logger.error(
      'Failed to register Pesapal IPN:',
      error.response?.data || error.message
    );
    throw new Error('Failed to register IPN with Pesapal');
  }
}

/**
 * Initialize Pesapal payment
 */
export async function initializePesapalPayment({
  bookingId,
  email,
  amount,
  currency,
  phoneNumber,
  metadata,
}) {
  try {
    logger.info('Initializing Pesapal payment:', {
      bookingId,
      amount,
      currency,
    });

    // One snapshot for the whole flow — token, IPN and order submission must
    // all agree on which Pesapal environment they're talking to.
    const config = requirePesapalConfig();
    const { baseUrl, appUrl } = config;

    const token = await getPesapalAuthToken(config);
    const notificationId = await getOrRegisterIPN(token, config);

    const merchantReference = `BK-${bookingId.slice(0, 8)}-${Date.now()}`;

    const orderData = {
      id: merchantReference,
      currency: currency || 'KES',
      amount: parseFloat(amount),
      description: `Payment for ${metadata?.tour_title || 'Tour Booking'} - ${metadata?.booking_reference}`,
      // ✅ BACKEND callback URL (like Paystack)
      callback_url: `${appUrl}/api/payments/pesapal/callback`,
      notification_id: notificationId,
      billing_address: {
        email_address: email,
        phone_number: phoneNumber || '',
        country_code: 'KE',
        first_name: metadata?.customer_name?.split(' ')[0] || 'Customer',
        last_name: metadata?.customer_name?.split(' ').slice(1).join(' ') || '',
        line_1: '',
        line_2: '',
        city: '',
        state: '',
        postal_code: '',
        zip_code: '',
      },
    };

    const response = await axios.post(
      `${baseUrl}/api/Transactions/SubmitOrderRequest`,
      orderData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    const { order_tracking_id, redirect_url, merchant_reference } =
      response.data;

    if (!order_tracking_id || !redirect_url) {
      throw new Error('Invalid response from Pesapal');
    }

    // Create payment record
    const paymentRecord = {
      id: crypto.randomUUID(),
      booking_id: bookingId,
      amount: amount.toString(),
      currency: currency || 'KES',
      payment_method: 'pesapal',
      pesapal_tracking_id: order_tracking_id,
      pesapal_merchant_reference: merchant_reference,
      pesapal_redirect_url: redirect_url,
      status: 'pending',
      response_data: JSON.stringify(response.data),
      created_at: new Date(),
    };

    await db.insert(payments).values(paymentRecord);

    logger.info('Pesapal payment initialized:', {
      bookingId,
      trackingId: order_tracking_id,
    });

    return {
      success: true,
      message: 'Payment initialized successfully',
      payment_method: 'pesapal',
      authorization_url: redirect_url,
      tracking_id: order_tracking_id,
      merchant_reference: merchant_reference,
    };
  } catch (error) {
    logger.error(
      'Pesapal initialization failed:',
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.message || 'Failed to initialize Pesapal payment'
    );
  }
}

/**
 * Verify Pesapal payment status
 */
export async function verifyPesapalPayment(orderTrackingId) {
  try {
    logger.info('Verifying Pesapal payment:', { orderTrackingId });

    const config = requirePesapalConfig();
    const { baseUrl } = config;
    const token = await getPesapalAuthToken(config);

    const response = await axios.get(
      `${baseUrl}/api/Transactions/GetTransactionStatus`,
      {
        params: { orderTrackingId },
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );

    const { payment_status_description, amount, currency, merchant_reference } =
      response.data;

    logger.info('Pesapal payment status:', {
      orderTrackingId,
      status: payment_status_description,
    });

    const payment = await db.query.payments.findFirst({
      where: eq(payments.pesapal_tracking_id, orderTrackingId),
    });

    if (!payment) {
      throw new Error('Payment record not found');
    }

    const isCompleted = payment_status_description === 'Completed';
    const isFailed = ['Failed', 'Invalid'].includes(payment_status_description);

    if (isCompleted && payment.status !== 'completed') {
      await handleSuccessfulPayment(
        payment.booking_id,
        orderTrackingId,
        response.data
      );
    } else if (isFailed && payment.status !== 'failed') {
      await handleFailedPayment(payment.booking_id, orderTrackingId);
    }

    return {
      success: true,
      status: payment_status_description,
      amount,
      currency,
      merchant_reference,
    };
  } catch (error) {
    logger.error('Pesapal verification failed:', error);
    throw error;
  }
}

/**
 * Handle Pesapal IPN notification
 */
export async function handlePesapalIPN(data) {
  try {
    const { OrderTrackingId, OrderMerchantReference } = data;

    if (!OrderTrackingId) {
      logger.warn('IPN received without tracking ID');
      return;
    }

    logger.info('Processing Pesapal IPN:', { OrderTrackingId });
    await verifyPesapalPayment(OrderTrackingId);
  } catch (error) {
    logger.error('Error processing Pesapal IPN:', error);
  }
}

/**
 * Handle successful payment
 */
async function handleSuccessfulPayment(bookingId, trackingId, transactionData) {
  try {
    await db
      .update(payments)
      .set({
        status: 'completed',
        completed_at: new Date(),
        response_data: JSON.stringify(transactionData),
      })
      .where(eq(payments.pesapal_tracking_id, trackingId));

    const [updatedBooking] = await db
      .update(bookings)
      .set({
        payment_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(bookings.id, bookingId))
      .returning();

    if (!updatedBooking) {
      throw new Error('Failed to update booking');
    }

    await invalidateBooking(
      updatedBooking.id,
      updatedBooking.user_id,
      updatedBooking.tour_id,
      updatedBooking.booking_reference
    );

    try {
      await emailService.sendPaymentConfirmation({
        ...updatedBooking,
        payment_method: 'pesapal',
      });
    } catch (emailError) {
      logger.error('Failed to send confirmation email:', emailError);
    }

    logger.info('Pesapal payment completed:', { bookingId, trackingId });
  } catch (error) {
    logger.error('Error handling successful payment:', error);
    throw error;
  }
}

/**
 * Handle failed payment
 */
async function handleFailedPayment(bookingId, trackingId) {
  try {
    await db
      .update(payments)
      .set({ status: 'failed' })
      .where(eq(payments.pesapal_tracking_id, trackingId));

    logger.info('Pesapal payment marked as failed:', { bookingId, trackingId });
  } catch (error) {
    logger.error('Error handling failed payment:', error);
    throw error;
  }
}
