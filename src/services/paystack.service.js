import axios from 'axios';
import crypto from 'crypto';
import {
  paystackConfig,
  requirePaystackConfig,
} from '#config/paystack.config.js';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { payments } from '#models/payment.model.js';
import { bookings } from '#models/booking.model.js';
import { eq, and, ne } from 'drizzle-orm';
import logger from '#config/logger.js';
import { emailService } from './email.service.js';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';
import { recordBookingSettlement } from './bookingLedger.service.js';

// Paystack is a third party that can hang. Without a bound, a slow
// response holds this request and its connection open indefinitely.
const PAYSTACK_TIMEOUT_MS = Number(process.env.PAYSTACK_TIMEOUT_MS || 15000);

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/**
 * Initialize Paystack payment
 */

export const initializePaystackPayment = async ({
  bookingId,
  email,
  amount,
  currency = 'KES',
  metadata,
}) => {
  try {
    requirePaystackConfig();
    // Generate unique reference
    const reference = `FA-${bookingId}-${Date.now()}`;

    // Create payment record
    const [payment] = await withTenantDb((tx) =>
      tx
        .insert(payments)
        .values({
          tenant_id: currentTenantId(),
          booking_id: bookingId,
          amount: amount.toString(),
          currency,
          payment_method: 'paystack',
          paystack_reference: reference,
          status: 'pending',
        })
        .returning()
    );

    // ✅ Construct callback URL
    const callbackUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/payment/callback`
      : 'http://localhost:3000/payment/callback';

    // Initialize transaction with Paystack
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: Math.round(parseFloat(amount) * 100), // Convert to kobo/cents
        currency,
        reference,
        callback_url: callbackUrl, // ✅ Use constructed URL
        metadata: {
          booking_id: bookingId,
          payment_id: payment.id,
          ...metadata, // ✅ Spread additional metadata
          custom_fields: [
            {
              display_name: 'Booking Reference',
              variable_name: 'booking_id',
              value: bookingId,
            },
          ],
        },
        channels: ['card'],
      },
      {
        headers: {
          Authorization: `Bearer ${paystackConfig.secretKey}`,
          'Content-Type': 'application/json',
        },
        timeout: PAYSTACK_TIMEOUT_MS,
      }
    );

    const {
      authorization_url,
      access_code,
      reference: paystackRef,
    } = response.data.data;

    // Update payment with Paystack response
    await withTenantDb((tx) =>
      tx
        .update(payments)
        .set({
          paystack_access_code: access_code,
          paystack_authorization_url: authorization_url,
          response_data: JSON.stringify(response.data),
        })
        .where(eq(payments.id, payment.id))
    );

    logger.info('Paystack payment initialized:', {
      bookingId,
      reference: paystackRef,
      authUrl: authorization_url,
      callbackUrl, // ✅ Log callback URL for debugging
    });

    return {
      success: true,
      message: 'Payment initialized successfully',
      data: {
        authorization_url,
        access_code,
        reference: paystackRef,
        payment_id: payment.id,
      },
    };
  } catch (error) {
    logger.error(
      'Failed to initialize Paystack payment:',
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.message || 'Failed to initialize payment'
    );
  }
};

/**
 * Verify Paystack payment
 */

export const verifyPaystackPayment = async (reference) => {
  try {
    // Verification only calls the API, so the URLs aren't needed.
    requirePaystackConfig(['PAYSTACK_SECRET_KEY']);

    logger.info('Verifying Paystack payment:', { reference });

    // Find payment by reference first — no need to call Paystack at all
    // if we've already settled this one.
    const [payment] = await withTenantDb((tx) =>
      tx
        .select()
        .from(payments)
        .where(eq(payments.paystack_reference, reference))
        .limit(1)
    );

    if (!payment) {
      throw new Error('Payment not found');
    }

    // ✅ Idempotency: stop before ever touching Paystack's API.
    if (payment.status === 'completed') {
      logger.info('Payment already verified, skipping:', { reference });
      return {
        success: true,
        message: 'Payment already verified',
        data: { reference, booking_id: payment.booking_id },
      };
    }

    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${paystackConfig.secretKey}`,
        },
        timeout: PAYSTACK_TIMEOUT_MS,
      }
    );
    const { status, data } = response.data;
    if (!status) {
      throw new Error('Payment verification failed');
    }

    // Check if payment was successful
    if (data.status === 'success') {
      // ✅ Verify the paid amount matches what's expected, before trusting it
      const expectedMinor = Math.round(parseFloat(payment.amount) * 100);
      if (data.amount !== expectedMinor || data.currency !== payment.currency) {
        logger.error('Paystack amount mismatch:', {
          reference,
          expectedMinor,
          receivedAmount: data.amount,
          expectedCurrency: payment.currency,
          receivedCurrency: data.currency,
        });
        throw new Error('Payment amount mismatch');
      }

      // Conditional on the payment still being incomplete, so concurrent
      // verifications cannot both complete it. Only the caller whose UPDATE
      // actually changes a row goes on to settle.
      const [completedPayment] = await withTenantDb((tx) =>
        tx
          .update(payments)
          .set({
            status: 'completed',
            completed_at: new Date(),
            response_data: JSON.stringify(response.data),
          })
          .where(
            and(eq(payments.id, payment.id), ne(payments.status, 'completed'))
          )
          .returning()
      );

      if (completedPayment) {
        // recordBookingSettlement reads booking.booking_reference for the
        // settlement notes, which is what reconciliation matches on. Fetched
        // here rather than at the later email step, which ran after this call
        // and left every Paystack settlement with a null reference.
        const settledBooking = await withTenantDb((tx) =>
          tx.query.bookings.findFirst({
            where: eq(bookings.id, payment.booking_id),
          })
        );

        // Money has moved: record it and spend it against the receivable.
        await recordBookingSettlement({
          payment: completedPayment,
          booking: settledBooking,
        });
      } else {
        logger.info(
          'Paystack completion already claimed, skipping settlement',
          {
            paymentId: payment.id,
          }
        );

        // Returning rather than falling through. The request that won the
        // claim is already updating the booking and sending the confirmation,
        // so continuing here confirmed the same booking twice and sent the
        // customer a second payment-confirmation email for one payment.
        return {
          success: true,
          message: 'Payment already processed',
          data: {
            reference,
            amount: data.amount / 100,
            currency: data.currency,
            paid_at: data.paid_at,
            channel: data.channel,
            booking_id: payment.booking_id,
          },
        };
      }

      // Update booking
      await withTenantDb((tx) =>
        tx
          .update(bookings)
          .set({
            payment_status: 'paid',
            payment_method: 'paystack',
            payment_id: reference,
            status: 'confirmed',
            updated_at: new Date(),
          })
          .where(eq(bookings.id, payment.booking_id))
      );

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
          });
        } catch (emailError) {
          logger.error(
            'Failed to send payment confirmation email:',
            emailError
          );
          // Don't fail the payment if email fails
        }
      }

      // ✅ Invalidate caches
      try {
        await cache.del(CacheKeys.booking(payment.booking_id));
        await cache.delPattern(
          CacheKeys.patterns.userBookings(booking?.user_id)
        );
        await cache.delPattern(CacheKeys.patterns.bookingLists());
      } catch (cacheError) {
        logger.error('Cache invalidation error (non-critical):', cacheError);
      }

      logger.info('Payment verified successfully:', {
        bookingId: payment.booking_id,
        reference,
        amount: data.amount / 100,
      });

      return {
        success: true,
        message: 'Payment verified successfully',
        data: {
          reference,
          amount: data.amount / 100,
          currency: data.currency,
          paid_at: data.paid_at,
          channel: data.channel,
          booking_id: payment.booking_id, // ✅ Return booking ID for redirect
        },
      };
    } else {
      // Payment failed
      await withTenantDb((tx) =>
        tx
          .update(payments)
          .set({
            status: 'failed',
            response_data: JSON.stringify(response.data),
          })
          // Guarded the same way the success claim is. Matching on id alone,
          // a verification that read this payment as pending could overwrite a
          // completion another request had already committed, leaving a paid
          // booking attached to a failed payment.
          .where(
            and(eq(payments.id, payment.id), eq(payments.status, 'pending'))
          )
      );

      logger.error('Payment failed:', { reference, status: data.status });

      return {
        success: false,
        message: data.gateway_response || 'Payment failed',
        data: {
          reference,
          status: data.status,
        },
      };
    }
  } catch (error) {
    logger.error(
      'Error verifying payment:',
      error.response?.data || error.message
    );
    throw error;
  }
};

/**
 * Handle Paystack webhook
 */
export const handlePaystackWebhook = async (payload, signature, rawBody) => {
  try {
    // Only the secret is needed here — no URLs are built on this path. Checked
    // explicitly because createHmac with an undefined key throws a bare
    // TypeError that says nothing about the missing variable.
    requirePaystackConfig(['PAYSTACK_SECRET_KEY']);

    // Verify webhook signature against the raw request bytes
    const hash = crypto
      .createHmac('sha512', paystackConfig.secretKey)
      .update(rawBody)
      .digest('hex');

    const expected = Buffer.from(hash, 'hex');
    const received = Buffer.from(String(signature || ''), 'hex');

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      logger.error('Invalid webhook signature');
      throw new Error('Invalid signature');
    }

    const { event, data } = payload;

    logger.info('Paystack webhook received:', {
      event,
      reference: data.reference,
    });

    // Handle charge.success event
    if (event === 'charge.success') {
      await verifyPaystackPayment(data.reference);
    }

    return { success: true };
  } catch (error) {
    logger.error('Error handling Paystack webhook:', error);
    throw error;
  }
};

/**
 * Get supported banks (for bank transfer)
 */
export const getSupportedBanks = async () => {
  try {
    // Without this a missing PAYSTACK_SECRET_KEY sent 'Bearer undefined'
    // and surfaced as a provider auth error rather than a config error.
    requirePaystackConfig();
    const response = await axios.get(`${PAYSTACK_BASE_URL}/bank?currency=KES`, {
      headers: {
        Authorization: `Bearer ${paystackConfig.secretKey}`,
      },
      timeout: PAYSTACK_TIMEOUT_MS,
    });

    return response.data.data;
  } catch (error) {
    logger.error('Failed to get banks:', error);
    throw error;
  }
};
