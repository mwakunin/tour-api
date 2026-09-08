import axios from 'axios';
import { mpesaConfig, requireMpesaConfig } from '#config/mpesa.config.js';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { payments } from '#models/payment.model.js';
import { bookings } from '#models/booking.model.js';
import { eq, and, ne } from 'drizzle-orm';
import logger from '#config/logger.js';
import { emailService } from './email.service.js';
import { recordBookingSettlement } from './bookingLedger.service.js';
import { invalidateBooking } from '#utils/cacheInvalidation.js';
import { tenants } from '#models/tenant.model.js';
import { decimalToCents } from '#utils/money.js';

// Logged once per process so "are we hitting live Safaricom?" is answerable
// from the logs rather than inferred from a URL in an error message.
let loggedMode = false;

/**
 * Generate M-Pesa access token
 */
export const generateAccessToken = async () => {
  // Every Daraja call funnels through here, so this is the one place that has
  // to be sure the credentials actually exist.
  requireMpesaConfig();

  if (!loggedMode) {
    logger.info(
      `[M-Pesa] Using ${mpesaConfig.environment.toUpperCase()} endpoint ${mpesaConfig.baseURL}`
    );
    loggedMode = true;
  }

  try {
    const auth = Buffer.from(
      `${mpesaConfig.consumerKey}:${mpesaConfig.consumerSecret}`
    ).toString('base64');

    const response = await axios.get(
      `${mpesaConfig.baseURL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    return response.data.access_token;
  } catch (error) {
    logger.error(
      'Failed to generate M-Pesa access token:',
      error.response?.data || error.message
    );
    throw new Error('Failed to authenticate with M-Pesa');
  }
};

/**
 * Generate M-Pesa password
 */
const generatePassword = () => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, -3);

  const password = Buffer.from(
    `${mpesaConfig.shortcode}${mpesaConfig.passkey}${timestamp}`
  ).toString('base64');

  return { password, timestamp };
};

/**
 * Format phone number to M-Pesa format (254XXXXXXXXX)
 */
const formatPhoneNumber = (phone) => {
  // Remove spaces, hyphens, plus signs
  let cleaned = phone.replace(/[\s\-+]/g, '');

  // If starts with 0, replace with 254
  if (cleaned.startsWith('0')) {
    cleaned = `254${cleaned.substring(1)}`;
  }

  // If doesn't start with 254, add it
  if (!cleaned.startsWith('254')) {
    cleaned = `254${cleaned}`;
  }

  return cleaned;
};

/**
 * Initiate STK Push
 */
/**
 * What Safaricom will actually take, in cents, for a KES amount.
 *
 * Rounded UP to a whole shilling, and the ceiling taken in integer cents.
 * Exported for the tests that pin both halves.
 */
export const chargeableCents = (amount) =>
  Math.ceil(decimalToCents(amount) / 100) * 100;

export const initiateSTKPush = async ({
  bookingId,
  phoneNumber,
  amount,
  currency = 'KES',
}) => {
  try {
    // ✅ CRITICAL: Validate currency is KES
    if (currency && currency.toUpperCase() !== 'KES') {
      throw new Error(
        'M-Pesa payments are only available for Kenyan Shillings (KES)'
      );
    }

    const accessToken = await generateAccessToken();
    const { password, timestamp } = generatePassword();
    const formattedPhone = formatPhoneNumber(phoneNumber);

    // Create payment record
    // Daraja requires the transaction type to match the shortcode kind, and
    // that is a property of the operator, not the deployment: a Paybill takes
    // CustomerPayBillOnline, a Till takes CustomerBuyGoodsOnline, and the
    // wrong one fails the push. Falls back to the configured default for
    // callers with no tenant context.
    const [tenantRow] = await withTenantDb((tx) =>
      tx
        .select({ shortcodeType: tenants.mpesa_shortcode_type })
        .from(tenants)
        .where(eq(tenants.id, currentTenantId()))
        .limit(1)
    );
    const transactionType =
      tenantRow?.shortcodeType === 'till'
        ? 'CustomerBuyGoodsOnline'
        : mpesaConfig.transactionType;

    // Daraja only accepts whole shillings, so this is the figure the customer
    // is actually charged. Persist that same value rather than the unrounded
    // input — otherwise the settlement records an amount that never moved.
    //
    // UP, not to nearest. Math.round sent a 100.40 booking to Safaricom as
    // 100, and the callback then marked the booking paid with 40 cents still
    // owed — the receivable said one thing and payment_status said another.
    // Rounding up can only overpay, and an overpayment is something the money
    // layer already has an answer for: the excess stays unallocated on the
    // settlement and surfaces in the unmatched worklist.
    //
    // Ceiling taken in integer cents rather than on the float. Math.ceil of a
    // parseFloat is at the mercy of the artifact that makes 1.15 * 100 come
    // out as 114.99999999999999, and here it would round a whole-shilling
    // amount up to the next one.
    const chargedCents = chargeableCents(amount);
    const chargedAmount = chargedCents / 100;

    const [payment] = await withTenantDb((tx) =>
      tx
        .insert(payments)
        .values({
          tenant_id: currentTenantId(),
          booking_id: bookingId,
          amount_cents: chargedCents,
          currency: 'KES',
          payment_method: 'mpesa',
          mpesa_phone_number: formattedPhone,
          status: 'pending',
        })
        .returning()
    );

    // STK Push request payload
    const payload = {
      BusinessShortCode: mpesaConfig.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: chargedAmount, // M-Pesa requires whole shillings
      PartyA: formattedPhone, // Customer phone
      PartyB: mpesaConfig.shortcode, // Your Till Number
      PhoneNumber: formattedPhone,
      CallBackURL: mpesaConfig.callbackURL,
      AccountReference: bookingId, // Booking ID as reference
      TransactionDesc: `Payment for booking ${bookingId}`,
    };

    logger.info('Initiating M-Pesa STK Push:', {
      bookingId,
      phone: formattedPhone,
      amount,
    });

    const response = await axios.post(
      `${mpesaConfig.baseURL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Update payment with M-Pesa response
    await withTenantDb((tx) =>
      tx
        .update(payments)
        .set({
          merchant_request_id: response.data.MerchantRequestID,
          checkout_request_id: response.data.CheckoutRequestID,
          response_data: JSON.stringify(response.data),
        })
        .where(eq(payments.id, payment.id))
    );

    logger.info('STK Push initiated successfully:', response.data);

    return {
      success: true,
      message: 'STK push sent to customer phone',
      checkoutRequestId: response.data.CheckoutRequestID,
      merchantRequestId: response.data.MerchantRequestID,
      paymentId: payment.id,
    };
  } catch (error) {
    logger.error('STK Push failed:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.errorMessage || 'Failed to initiate payment'
    );
  }
};

/**
 * Handle M-Pesa callback
 */

export const handleMpesaCallback = async (callbackData) => {
  try {
    logger.info(
      'M-Pesa callback received:',
      JSON.stringify(callbackData, null, 2)
    );

    // const { Body } = callbackData;
    // const { stkCallback } = Body;
    // const {
    //   _MerchantRequestID,
    //   CheckoutRequestID,
    //   ResultCode,
    //   ResultDesc,
    //   CallbackMetadata,
    // } = stkCallback;

    const stkCallback = callbackData?.Body?.stkCallback;

    if (!stkCallback) {
      logger.warn('M-Pesa callback missing Body.stkCallback');
      return { success: false, message: 'Invalid callback payload' };
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } =
      stkCallback;

    // Find payment by checkout request ID
    const [payment] = await withTenantDb((tx) =>
      tx
        .select()
        .from(payments)
        .where(eq(payments.checkout_request_id, CheckoutRequestID))
        .limit(1)
    );

    if (!payment) {
      logger.error(
        'Payment not found for CheckoutRequestID:',
        CheckoutRequestID
      );
      return { success: false, message: 'Payment not found' };
    }

    // Safaricom retries callbacks. Without this guard a retry re-runs the
    // completion path and records the same money a second time, so the ledger
    // shows twice what the customer actually paid. Matches the early-return
    // Paystack verification already does.
    if (payment.status === 'completed') {
      logger.info('M-Pesa callback ignored, payment already completed', {
        paymentId: payment.id,
        checkoutRequestId: CheckoutRequestID,
      });
      return { success: true, message: 'Payment already processed' };
    }

    // Check if payment was successful
    if (ResultCode === 0) {
      // Extract metadata
      const metadata = CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = metadata.find(
        (item) => item.Name === 'MpesaReceiptNumber'
      )?.Value;
      const transactionDate = metadata.find(
        (item) => item.Name === 'TransactionDate'
      )?.Value;
      const phoneNumber = metadata.find(
        (item) => item.Name === 'PhoneNumber'
      )?.Value;
      const reportedAmount = metadata.find(
        (item) => item.Name === 'Amount'
      )?.Value;

      // Confirm Safaricom is telling us about the money we asked for. Paystack
      // and Pesapal both do this; M-Pesa did not, and read no Amount from the
      // callback at all — so a callback reporting any figure marked the
      // booking paid for whatever it said. One rail out of three without the
      // check is the pair-that-drifts shape, not a considered difference.
      //
      // Absent rather than wrong is refused too: a success callback with no
      // Amount is not something to complete on the assumption it matched.
      // A malformed figure is a mismatch, not a server fault. decimalToCents
      // throws on anything that is not a decimal, and letting that escape
      // answered the callback with a 500 -- so Safaricom retried a payload
      // that will never parse, forever, instead of being told the amount was
      // refused.
      let reportedCents = null;
      if (reportedAmount !== undefined && reportedAmount !== null) {
        try {
          reportedCents = decimalToCents(String(reportedAmount));
        } catch {
          reportedCents = null;
        }
      }

      // ASK SAFARICOM, DO NOT TAKE THE CALLBACK'S WORD.
      //
      // This endpoint is public — it has to be, Safaricom calls it — and
      // Daraja does not sign STK callbacks, so there is no signature to
      // check. Until now that meant anyone who could POST a success payload
      // naming a pending CheckoutRequestID got a booking confirmed and a
      // settlement recorded with no money behind it. The realistic attacker
      // is not a stranger guessing: it is the customer who started a real
      // push, was handed the CheckoutRequestID in the response, cancelled on
      // their handset and replayed a success.
      //
      // The other two rails already establish trust rather than assuming it —
      // Paystack verifies an HMAC over the raw bytes, and Pesapal ignores its
      // callback body entirely and reads GetTransactionStatus. M-Pesa was the
      // one that did neither. Same idea here, with the query API this file
      // already speaks.
      //
      // A query that cannot be reached is not a confirmation, so it throws
      // and the controller answers non-zero: Safaricom retries, the payment
      // stays pending, and nothing is completed on a maybe.
      const confirmation = await querySTKPushStatus(CheckoutRequestID);
      if (String(confirmation?.ResultCode) !== '0') {
        logger.error('M-Pesa callback not confirmed by Safaricom — refusing', {
          paymentId: payment.id,
          checkoutRequestId: CheckoutRequestID,
          queriedResultCode: confirmation?.ResultCode,
          queriedResultDesc: confirmation?.ResultDesc,
        });
        return {
          success: false,
          status: 'unconfirmed',
          message: 'Safaricom does not report this payment as successful',
        };
      }

      if (reportedCents !== payment.amount_cents) {
        logger.error('M-Pesa amount mismatch — refusing to complete', {
          paymentId: payment.id,
          checkoutRequestId: CheckoutRequestID,
          expectedCents: payment.amount_cents,
          reportedCents,
        });
        return {
          success: false,
          status: 'mismatch',
          message: 'Reported payment does not match the recorded amount',
        };
      }

      // All three writes in one transaction: the payment claim, the booking
      // confirmation, and the settlement that records the money in the ledger.
      // The UPDATE is conditional on the payment not already being completed,
      // so a retried callback claims nothing and settles nothing.
      const [completedPayment] = await withTenantDb(async (tx) => {
        const updated = await tx
          .update(payments)
          .set({
            status: 'completed',
            mpesa_receipt_number: mpesaReceiptNumber,
            mpesa_phone_number: phoneNumber?.toString(),
            completed_at: new Date(),
            response_data: JSON.stringify(callbackData),
          })
          .where(
            and(eq(payments.id, payment.id), ne(payments.status, 'completed'))
          )
          .returning();

        if (updated.length > 0) {
          await tx
            .update(bookings)
            .set({
              payment_status: 'paid',
              payment_method: 'mpesa',
              payment_id: mpesaReceiptNumber,
              status: 'confirmed',
              updated_at: new Date(),
            })
            .where(eq(bookings.id, payment.booking_id));

          // Settled here rather than after the commit. Outside, a ledger
          // failure left a completed payment and a confirmed booking with no
          // settlement — permanently, because the next callback sees
          // 'completed', claims nothing and skips the settlement again. The
          // earlier reasoning for keeping it out ("a ledger failure must not
          // roll back a payment the customer already made") does not hold:
          // rolling the record back does not un-take the money, it means
          // Safaricom retries the callback until the books agree, which is
          // the only outcome that ends with them agreeing.
          await recordBookingSettlement({ payment: updated[0] });
        }
        return updated;
      });

      if (!completedPayment) {
        logger.info('M-Pesa completion already claimed, skipping', {
          paymentId: payment.id,
          checkoutRequestId: CheckoutRequestID,
        });
        return { success: true, message: 'Payment already processed' };
      }

      // ✅ Get complete booking with tour details for email
      const booking = await withTenantDb((tx) =>
        tx.query.bookings.findFirst({
          where: eq(bookings.id, payment.booking_id),
          with: {
            tour: true,
          },
        })
      );

      // ✅ Send payment confirmation email with invoice
      if (booking) {
        try {
          await emailService.sendPaymentConfirmation(booking);
          logger.info('Payment confirmation email sent:', {
            bookingId: booking.id,
            receipt: mpesaReceiptNumber,
          });
        } catch (emailError) {
          logger.error(
            'Failed to send payment confirmation email:',
            emailError
          );
          // Don't fail the callback if email fails
        }
      }

      // Uses the shared helper. This previously imported '#config/cache.js',
      // which does not exist — and because the import sat inside this
      // try/catch it failed silently, so booking caches were never cleared
      // after a successful payment and clients kept reading a stale pending
      // booking.
      try {
        await invalidateBooking(
          payment.booking_id,
          booking?.user_id,
          booking?.tour_id,
          booking?.booking_reference
        );
        logger.info('Caches invalidated for booking:', payment.booking_id);
      } catch (cacheError) {
        logger.error('Cache invalidation error (non-critical):', cacheError);
        // Don't fail the callback if cache invalidation fails
      }

      logger.info('Payment completed successfully:', {
        bookingId: payment.booking_id,
        receipt: mpesaReceiptNumber,
        phoneNumber,
        transactionDate,
      });

      return {
        success: true,
        message: 'Payment processed successfully',
        receipt: mpesaReceiptNumber,
      };
    } else {
      // Payment failed
      await withTenantDb((tx) =>
        tx
          .update(payments)
          .set({
            status: 'failed',
            response_data: JSON.stringify(callbackData),
          })
          // payment.status was read well before this ran, so it is stale by
          // now. Matching on id alone, a late failure callback could write
          // 'failed' over a completion another callback had already committed,
          // leaving a paid, confirmed booking with a settlement posted against
          // a payment row that says it failed. paystack and pesapal already
          // guard their failure paths this way.
          .where(
            and(eq(payments.id, payment.id), eq(payments.status, 'pending'))
          )
      );

      logger.error('Payment failed:', { ResultCode, ResultDesc });

      return {
        success: false,
        message: ResultDesc || 'Payment failed',
      };
    }
  } catch (error) {
    logger.error('Error handling M-Pesa callback:', error);
    throw error;
  }
};

/**
 * Query STK Push status (for checking payment status manually)
 */
export const querySTKPushStatus = async (checkoutRequestId) => {
  try {
    const accessToken = await generateAccessToken();
    const { password, timestamp } = generatePassword();

    const payload = {
      BusinessShortCode: mpesaConfig.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    const response = await axios.post(
      `${mpesaConfig.baseURL}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error(
      'Failed to query STK push status:',
      error.response?.data || error.message
    );
    throw error;
  }
};
