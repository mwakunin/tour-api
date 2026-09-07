import axios from 'axios';
import crypto from 'crypto';
import logger from '#config/logger.js';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { bookings } from '#models/booking.model.js';
import { payments } from '#models/payment.model.js';
import { and, eq, ne } from 'drizzle-orm';
import { emailService } from './email.service.js';
import { invalidateBooking } from '#utils/cacheInvalidation.js';
import { recordBookingSettlement } from './bookingLedger.service.js';
import { decimalToCents } from '#utils/money.js';

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
      tenant_id: currentTenantId(),
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

    await withTenantDb((tx) => tx.insert(payments).values(paymentRecord));

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
      merchant_reference,
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

    const payment = await withTenantDb((tx) =>
      tx.query.payments.findFirst({
        where: eq(payments.pesapal_tracking_id, orderTrackingId),
      })
    );

    if (!payment) {
      throw new Error('Payment record not found');
    }

    const isCompleted = payment_status_description === 'Completed';
    const isFailed = ['Failed', 'Invalid'].includes(payment_status_description);

    // Confirm the provider is telling us about the amount we actually asked
    // for. Without this a tampered or mismatched callback marks a booking paid
    // for whatever the provider reports — Paystack verification already does
    // this comparison.
    if (isCompleted) {
      const expectedCents = decimalToCents(payment.amount);
      const reportedCents = decimalToCents(amount);
      if (expectedCents !== reportedCents || currency !== payment.currency) {
        logger.error(
          'Pesapal amount/currency mismatch — refusing to complete',
          {
            orderTrackingId,
            expected: `${payment.amount} ${payment.currency}`,
            reported: `${amount} ${currency}`,
          }
        );
        return {
          success: false,
          status: 'mismatch',
          message: 'Reported payment does not match the recorded amount',
        };
      }
    }

    // The status read above happened earlier in this request, so it is stale
    // by the time we act on it: two concurrent IPNs for one payment both saw
    // 'pending' and both settled. Claim the transition with a conditional
    // UPDATE instead — only the caller whose UPDATE actually changes a row
    // goes on to settle.
    if (isCompleted) {
      // The claim and everything it commits the operator to — the settlement
      // and the booking confirmation — share one transaction.
      //
      // Split across two, a failure after the claim was unrecoverable: the
      // payment was already 'completed', so the next IPN's conditional claim
      // matched no rows, logged 'already claimed', and returned. The booking
      // stayed unconfirmed forever with the money recorded as received. The
      // lock that stops double-processing also stopped the retry.
      //
      // withTenantDb reuses an ambient transaction, so the writes inside
      // recordPesapalSuccess join this one instead of opening their own.
      const confirmedBooking = await withTenantDb(async (tx) => {
        // Claimed by moving straight to 'completed' — the status enum is
        // pending/completed/failed, so there is no intermediate state to park
        // in and adding one would be a migration for a lock.
        const claimed = await tx
          .update(payments)
          .set({ status: 'completed', completed_at: new Date() })
          .where(
            and(eq(payments.id, payment.id), ne(payments.status, 'completed'))
          )
          .returning({ id: payments.id });

        if (claimed.length === 0) return null;

        return recordPesapalSuccess(
          payment.booking_id,
          orderTrackingId,
          response.data
        );
      });

      if (confirmedBooking) {
        // Only once the transaction has committed. Resend inside it would
        // hold the payment and booking rows locked across an HTTP call, and a
        // later rollback would leave the customer holding a confirmation for
        // a booking the database no longer says is confirmed.
        await notifyPesapalSuccess(confirmedBooking, orderTrackingId);
      } else {
        logger.info('Pesapal completion already claimed, skipping', {
          orderTrackingId,
          paymentId: payment.id,
        });
      }
    } else if (isFailed) {
      // Same conditional-claim as the completion branch above, and it must not
      // move a payment that has already completed.
      const claimed = await withTenantDb((tx) =>
        tx
          .update(payments)
          .set({ status: 'failed' })
          .where(
            and(eq(payments.id, payment.id), eq(payments.status, 'pending'))
          )
          .returning({ id: payments.id })
      );

      if (claimed.length > 0) {
        await handleFailedPayment(payment.booking_id, orderTrackingId);
      }
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
    const { OrderTrackingId } = data;

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
 * The durable half of a successful payment: record the provider's response,
 * settle the money, and confirm the booking.
 *
 * Runs inside the caller's transaction — see verifyPesapalPayment — so a
 * failure anywhere here takes the payment claim down with it and leaves the
 * IPN retryable. Does no cache or email work for that reason; that is
 * notifyPesapalSuccess, after the commit.
 *
 * @returns the confirmed booking
 */
async function recordPesapalSuccess(bookingId, trackingId, transactionData) {
  try {
    const [completedPayment] = await withTenantDb((tx) =>
      tx
        .update(payments)
        .set({
          // Not status/completed_at: verifyPesapalPayment already claimed the
          // transition and stamped the time. Rewriting completed_at here moved
          // it to whenever this handler ran, and recordBookingSettlement uses
          // it as occurredAt — so the ledger recorded the handler's clock
          // rather than the moment the payment was claimed.
          response_data: JSON.stringify(transactionData),
        })
        .where(eq(payments.pesapal_tracking_id, trackingId))
        .returning()
    );

    // Money has moved: record it and spend it against the receivable.
    if (completedPayment) {
      await recordBookingSettlement({ payment: completedPayment });
    }

    const [updatedBooking] = await withTenantDb((tx) =>
      tx
        .update(bookings)
        .set({
          payment_status: 'paid',
          status: 'confirmed',
          confirmed_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(bookings.id, bookingId))
        .returning()
    );

    if (!updatedBooking) {
      throw new Error('Failed to update booking');
    }

    return updatedBooking;
  } catch (error) {
    logger.error('Error handling successful payment:', error);
    throw error;
  }
}

/**
 * The best-effort half: cache invalidation and the customer's receipt.
 *
 * Deliberately after the commit and deliberately non-throwing. The money is
 * already recorded and the booking already confirmed by the time this runs, so
 * a stale cache entry or an undelivered email is not a reason to fail the IPN
 * and have Pesapal redeliver a payment that is fully settled.
 */
async function notifyPesapalSuccess(booking, trackingId) {
  try {
    await invalidateBooking(
      booking.id,
      booking.user_id,
      booking.tour_id,
      booking.booking_reference
    );
  } catch (cacheError) {
    logger.error('Failed to invalidate booking caches:', cacheError);
  }

  try {
    await emailService.sendPaymentConfirmation({
      ...booking,
      payment_method: 'pesapal',
    });
  } catch (emailError) {
    logger.error('Failed to send confirmation email:', emailError);
  }

  logger.info('Pesapal payment completed:', {
    bookingId: booking.id,
    trackingId,
  });
}

/**
 * Handle failed payment
 */
async function handleFailedPayment(bookingId, trackingId) {
  try {
    await withTenantDb((tx) =>
      tx
        .update(payments)
        .set({ status: 'failed' })
        .where(eq(payments.pesapal_tracking_id, trackingId))
    );

    logger.info('Pesapal payment marked as failed:', { bookingId, trackingId });
  } catch (error) {
    logger.error('Error handling failed payment:', error);
    throw error;
  }
}
