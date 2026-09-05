import {
  initializePaystackPayment,
  verifyPaystackPayment,
} from './paystack.service.js';
import { initiateSTKPush } from './mpesa.service.js';
import {
  initializePesapalPayment,
  verifyPesapalPayment,
} from './pesapal.service.js';
import logger from '#config/logger.js';
import crypto from 'crypto';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { bookings } from '#models/booking.model.js';
import { payments } from '#models/payment.model.js';
import { eq, and } from 'drizzle-orm';
import { invalidateBooking } from '#utils/cacheInvalidation.js';
import { recordBookingSettlement } from './bookingLedger.service.js';

/**
 * Initialize payment (routes to correct provider)
 */
export const initializePayment = async ({
  bookingId,
  paymentMethod,
  amount,
  currency,
  phoneNumber,
  email,
  metadata,
}) => {
  try {
    logger.info('Initializing payment:', {
      bookingId,
      paymentMethod,
      amount,
      currency,
    });

    // ✅ Validate amount
    if (!amount || amount <= 0) {
      throw new Error('Invalid payment amount');
    }

    switch (paymentMethod) {
      case 'mpesa':
        if (!phoneNumber) {
          throw new Error('Phone number is required for M-Pesa');
        }
        return await initiateSTKPush({
          bookingId,
          phoneNumber,
          amount,
          currency,
          metadata,
        });

      // ✅ ADD THIS CASE
      case 'pesapal':
        if (!email) {
          throw new Error('Email is required for Pesapal');
        }
        return await initializePesapalPayment({
          bookingId,
          email,
          amount,
          currency: currency || 'KES',
          phoneNumber,
          metadata,
        });

      case 'paystack':
      case 'card':
        if (!email) {
          throw new Error('Email is required for card payments');
        }
        return await initializePaystackPayment({
          bookingId,
          email,
          amount,
          currency: currency || 'KES',
          metadata,
        });

      default:
        throw new Error(`Unsupported payment method: ${paymentMethod}`);
    }
  } catch (error) {
    logger.error('Payment initialization failed:', {
      error: error.message,
      bookingId,
      paymentMethod,
    });
    throw error;
  }
};

/**
 * Verify payment (routes to correct provider)
 */
export const verifyPayment = async ({
  reference,
  paymentMethod,
  orderTrackingId,
}) => {
  try {
    logger.info('Verifying payment:', {
      reference,
      paymentMethod,
      orderTrackingId,
    });

    switch (paymentMethod) {
      case 'pesapal':
        if (!orderTrackingId) {
          throw new Error('Order tracking ID is required for Pesapal');
        }
        return await verifyPesapalPayment(orderTrackingId);

      case 'paystack':
      case 'card':
        if (!reference) {
          throw new Error('Payment reference is required');
        }
        return await verifyPaystackPayment(reference);

      case 'mpesa':
        // M-Pesa verification happens via callback
        throw new Error('M-Pesa payments are verified via callback');

      default:
        throw new Error(`Unsupported payment method: ${paymentMethod}`);
    }
  } catch (error) {
    logger.error('Payment verification failed:', {
      error: error.message,
      reference,
      paymentMethod,
    });
    throw error;
  }
};

/**
 * Get payment methods available for a currency
 */
export const getAvailablePaymentMethods = (currency) => {
  const methods = [
    // ✅ ADD PESAPAL (make it primary)
    {
      id: 'pesapal',
      name: 'Card Payment',
      description: 'Visa, Mastercard, Mobile Money',
      currencies: ['KES', 'USD', 'TZS', 'UGX'],
      recommended: true,
    },
    {
      id: 'mpesa',
      name: 'M-Pesa',
      description: 'Mobile money (Kenya)',
      currencies: ['KES'],
    },
    {
      id: 'paystack',
      name: 'Card Payment',
      description: 'Visa, Mastercard, and other cards',
      currencies: ['USD', 'KES', 'NGN', 'GHS', 'ZAR'],
      deprecated: true,
    },
  ];

  //  return methods.filter((method) =>
  //    method.currencies.includes(currency || 'KES')
  // );
  //};
  // Filter by currency and hide deprecated unless explicitly requested
  return methods.filter(
    (method) =>
      method.currencies.includes(currency || 'KES') && !method.deprecated
  );
};

export const confirmBankTransfer = async (
  bookingId,
  confirmationData,
  confirmedByUserId
) => {
  try {
    // Get booking with relations
    const booking = await withTenantDb((tx) =>
      tx.query.bookings.findFirst({
        where: eq(bookings.id, bookingId),
        with: {
          tour: true,
          user: true,
        },
      })
    );

    if (!booking) {
      throw new Error('Booking not found');
    }

    // Verify it's a bank transfer booking
    if (booking.payment_method !== 'bank_transfer') {
      throw new Error('This booking is not a bank transfer payment');
    }

    // Check if already paid
    if (booking.payment_status === 'paid') {
      throw new Error('This booking has already been confirmed as paid');
    }

    // Update booking status
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

    // Create payment record
    const paymentRecord = {
      tenant_id: currentTenantId(),
      id: crypto.randomUUID(),
      booking_id: booking.id,
      user_id: booking.user_id,
      payment_method: 'bank_transfer',
      amount: confirmationData.amount_received || booking.total_price,
      currency: booking.currency,
      status: 'completed',
      receipt_number: confirmationData.receipt_number || null,
      notes: confirmationData.notes || null,
      confirmed_by: confirmedByUserId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    try {
      await withTenantDb((tx) => tx.insert(payments).values(paymentRecord));

      // Money has moved: record it and spend it against the receivable.
      await recordBookingSettlement({
        payment: { ...paymentRecord, completed_at: new Date() },
        booking: updatedBooking,
      });
    } catch (paymentError) {
      logger.warn('Failed to create payment record:', paymentError);
      // Continue even if payment record fails
    }

    // Invalidate cache
    await invalidateBooking(
      updatedBooking.id,
      updatedBooking.user_id,
      updatedBooking.tour_id,
      updatedBooking.booking_reference
    );

    logger.info('Bank transfer confirmed:', {
      bookingId,
      confirmedBy: confirmedByUserId,
      amount: paymentRecord.amount,
    });

    return {
      booking: updatedBooking,
      payment: paymentRecord,
    };
  } catch (error) {
    logger.error('Failed to confirm bank transfer:', error);
    throw error;
  }
};

export const getPendingBankTransfers = async (filters = {}) => {
  try {
    const { limit = 100, offset = 0 } = filters;

    const pendingTransfers = await withTenantDb((tx) =>
      tx.query.bookings.findMany({
        where: and(
          eq(bookings.payment_method, 'bank_transfer'),
          eq(bookings.payment_status, 'pending')
        ),
        with: {
          tour: true,
          user: true,
        },
        orderBy: (bookings, { desc }) => [desc(bookings.created_at)],
        limit,
        offset,
      })
    );

    logger.info(`Found ${pendingTransfers.length} pending bank transfers`);

    return pendingTransfers;
  } catch (error) {
    logger.error('Failed to get pending bank transfers:', error);
    throw error;
  }
};

export const getBankTransferStats = async () => {
  try {
    // Get counts
    const pending = await withTenantDb((tx) =>
      tx.query.bookings.findMany({
        where: and(
          eq(bookings.payment_method, 'bank_transfer'),
          eq(bookings.payment_status, 'pending')
        ),
      })
    );

    const confirmed = await withTenantDb((tx) =>
      tx.query.bookings.findMany({
        where: and(
          eq(bookings.payment_method, 'bank_transfer'),
          eq(bookings.payment_status, 'paid')
        ),
      })
    );

    // Calculate total amounts
    const pendingAmount = pending.reduce(
      (sum, b) => sum + parseFloat(b.total_price),
      0
    );

    const confirmedAmount = confirmed.reduce(
      (sum, b) => sum + parseFloat(b.total_price),
      0
    );

    return {
      pending: {
        count: pending.length,
        amount: pendingAmount,
      },
      confirmed: {
        count: confirmed.length,
        amount: confirmedAmount,
      },
    };
  } catch (error) {
    logger.error('Failed to get bank transfer stats:', error);
    throw error;
  }
};
