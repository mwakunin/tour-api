import {
  initializePayment,
  verifyPayment,
  confirmBankTransfer,
  getPendingBankTransfers,
  getBankTransferStats,
} from '#services/payment.service.js';
import { handleMpesaCallback } from '#services/mpesa.service.js';
import { handlePaystackWebhook } from '#services/paystack.service.js';
import { handlePesapalIPN } from '#services/pesapal.service.js';
import { withTenantDb } from '#config/tenantContext.js';
import { bookings } from '#models/booking.model.js';
import { eq } from 'drizzle-orm';
import logger from '#config/logger.js';
import { emailService } from '#services/email.service.js';
import { z } from 'zod';
// ✅ Import validations
import {
  validatePaymentInitialize,
  validatePaystackVerify,
  validateBankTransferConfirm,
  validateBankTransferQuery,
  validateMpesaCallback,
  validatePaystackWebhook,
  validatePesapalIPN,
  validatePesapalVerify,
} from '#validations/payment.validation.js';

/**
 * Initialize payment (unified endpoint)
 */
export const initiatePayment = async (req, res, next) => {
  try {
    // ✅ Validate input with Zod
    const validatedData = validatePaymentInitialize({
      booking_id: req.body.bookingId,
      payment_method: req.body.paymentMethod,
      phone_number: req.body.phoneNumber,
      email: req.body.email,
      currency: req.body.currency,
    });

    // Get booking with tour details
    const booking = await withTenantDb((tx) =>
      tx.query.bookings.findFirst({
        where: eq(bookings.id, validatedData.booking_id),
        with: {
          tour: true,
        },
      })
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    if (booking.payment_status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Booking already paid',
      });
    }

    // ✅ Validate booking belongs to user (security check)
    if (req.user && booking.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized to pay for this booking',
      });
    }

    // Initialize payment
    const result = await initializePayment({
      bookingId: booking.id,
      paymentMethod: validatedData.payment_method,
      // Always the booking's own total. A caller-supplied amount used to win
      // here, so anyone could charge themselves a token sum for any booking and
      // still have the gateway callback mark it paid and confirmed.
      amount: parseFloat(booking.total_price),
      phoneNumber: validatedData.phone_number,
      email: validatedData.email || booking.customer_email,
      currency: validatedData.currency || booking.currency,
      metadata: {
        booking_reference: booking.booking_reference,
        customer_name: booking.customer_name,
        tour_title: booking.tour?.title,
        group_size: booking.group_size,
      },
    });

    res.json(result);
  } catch (error) {
    // ✅ Handle Zod validation errors
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: error.issues.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    logger.error('Error initiating payment:', error);
    next(error);
  }
};

/**
 * Get payment status for a booking
 */
export const getPaymentStatus = async (req, res, next) => {
  try {
    const { bookingId } = req.params;

    // ✅ Basic UUID validation
    if (
      !bookingId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        bookingId
      )
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking ID',
      });
    }

    const booking = await withTenantDb((tx) =>
      tx.query.bookings.findFirst({
        where: eq(bookings.id, bookingId),
      })
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    // ✅ Security check
    if (req.user && booking.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    res.json({
      success: true,
      status: booking.payment_status,
      payment_method: booking.payment_method,
      total_price: booking.total_price,
      currency: booking.currency,
    });
  } catch (error) {
    logger.error('Error getting payment status:', error);
    next(error);
  }
};

// ✅ UPDATE verifyPaymentStatus to handle both Paystack and Pesapal
export const verifyPaymentStatus = async (req, res, next) => {
  try {
    const { reference, orderTrackingId, paymentMethod } = req.query;

    let result;

    if (orderTrackingId || paymentMethod === 'pesapal') {
      const validatedData = validatePesapalVerify({ orderTrackingId });
      result = await verifyPayment({
        orderTrackingId: validatedData.orderTrackingId,
        paymentMethod: 'pesapal',
      });
    } else if (reference) {
      const validatedData = validatePaystackVerify({ reference });
      result = await verifyPayment({
        reference: validatedData.reference,
        paymentMethod: 'paystack',
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either reference or orderTrackingId is required',
      });
    }

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: error.issues.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    logger.error('Error verifying payment:', error);
    next(error);
  }
};
/**
 * M-Pesa callback
 */
export const mpesaCallback = async (req, res) => {
  try {
    // ✅ Validate M-Pesa callback data
    try {
      validateMpesaCallback(req.body);
    } catch (validationError) {
      logger.warn('Invalid M-Pesa callback data:', validationError);
      // Still return success to prevent M-Pesa retries
      return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }

    await handleMpesaCallback(req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    logger.error('Error in M-Pesa callback:', error);
    // ✅ Still return success to M-Pesa to prevent retries
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  }
};

// ✅ ADD THESE NEW CONTROLLERS
/**
 * Pesapal IPN handler
 */
export const pesapalIPN = async (req, res) => {
  try {
    const data = req.method === 'GET' ? req.query : req.body;

    logger.info('Pesapal IPN received:', data);

    try {
      validatePesapalIPN(data);
    } catch (validationError) {
      logger.warn('Invalid Pesapal IPN data:', validationError);
      return res.sendStatus(200);
    }

    await handlePesapalIPN(data);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in Pesapal IPN:', error);
    res.sendStatus(200);
  }
};

/**
 * ✅ Pesapal Callback - User redirect after payment
 * This handles the user return from Pesapal (like Paystack)
 */
export const pesapalCallback = async (req, res) => {
  try {
    const { OrderTrackingId, OrderMerchantReference } = req.query;

    logger.info('Pesapal callback received:', {
      OrderTrackingId,
      OrderMerchantReference,
    });

    // Validate we have tracking ID
    if (!OrderTrackingId) {
      logger.error('Pesapal callback missing OrderTrackingId');
      return res.redirect(
        `${process.env.FRONTEND_URL}/payment/error?message=Invalid payment reference`
      );
    }

    // Verify the payment with Pesapal
    try {
      const result = await verifyPayment({
        orderTrackingId: OrderTrackingId,
        paymentMethod: 'pesapal',
      });

      logger.info('Pesapal payment verification result:', {
        OrderTrackingId,
        status: result.status,
      });

      // Handle successful payment
      if (result.status === 'Completed') {
        return res.redirect(
          `${process.env.FRONTEND_URL}/payment/success?reference=${OrderMerchantReference}&trackingId=${OrderTrackingId}`
        );
      }

      // Handle failed payment
      if (result.status === 'Failed' || result.status === 'Invalid') {
        return res.redirect(
          `${process.env.FRONTEND_URL}/payment/failed?reference=${OrderMerchantReference}&reason=${result.status}`
        );
      }

      // Handle pending/processing status
      return res.redirect(
        `${process.env.FRONTEND_URL}/payment/pending?reference=${OrderMerchantReference}&trackingId=${OrderTrackingId}`
      );
    } catch (verifyError) {
      logger.error('Error verifying Pesapal payment:', verifyError);
      return res.redirect(
        `${process.env.FRONTEND_URL}/payment/error?message=Verification failed`
      );
    }
  } catch (error) {
    logger.error('Error in Pesapal callback:', error);
    return res.redirect(
      `${process.env.FRONTEND_URL}/payment/error?message=Payment processing error`
    );
  }
};
/**
 * Paystack webhook
 */
// export const paystackWebhook = async (req, res) => {
//   try {
//     const signature = req.headers['x-paystack-signature'];

//     if (!signature) {
//       logger.warn('Paystack webhook received without signature');
//       return res.sendStatus(400);
//     }

//     // ✅ Validate webhook data
//     try {
//       validatePaystackWebhook(req.body);
//     } catch (validationError) {
//       logger.warn('Invalid Paystack webhook data:', validationError);
//       return res.sendStatus(400);
//     }

//     await handlePaystackWebhook(req.body, signature);
//     res.sendStatus(200);
//   } catch (error) {
//     logger.error('Error in Paystack webhook:', error);
//     res.sendStatus(400);
//   }
// };
export const paystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      logger.warn('Paystack webhook received without signature');
      return res.sendStatus(400);
    }
    // ✅ Validate webhook data
    try {
      validatePaystackWebhook(req.body);
    } catch (validationError) {
      logger.warn('Invalid Paystack webhook data:', validationError);
      return res.sendStatus(400);
    }
    await handlePaystackWebhook(req.body, signature, req.rawBody);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error in Paystack webhook:', error);
    res.sendStatus(400);
  }
};

/**
 * Confirm bank transfer payment
 */
export const confirmBankTransferController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const confirmedByUserId = req.user.id;

    // ✅ Validate input with Zod
    const validatedData = validateBankTransferConfirm(req.body);

    // Call service to confirm payment
    const result = await confirmBankTransfer(
      id,
      validatedData,
      confirmedByUserId
    );

    // Send confirmation email to customer
    try {
      await emailService.sendPaymentConfirmation({
        ...result.booking,
        payment_method: 'bank_transfer',
      });
    } catch (emailError) {
      logger.error('Failed to send payment confirmation email:', emailError);
      // Don't fail the request if email fails
    }

    res.json({
      success: true,
      message: 'Bank transfer confirmed successfully',
      data: result.booking,
    });
  } catch (error) {
    // ✅ Handle Zod validation errors
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: error.issues.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    // Handle service errors
    if (error.message === 'Booking not found') {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }

    if (
      error.message === 'This booking is not a bank transfer payment' ||
      error.message === 'This booking has already been confirmed as paid'
    ) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    next(error);
  }
};

/**
 * Get pending bank transfers
 */
export const getPendingBankTransfersController = async (req, res, next) => {
  try {
    // ✅ Validate query parameters
    const validatedQuery = validateBankTransferQuery(req.query);

    const filters = {
      limit: validatedQuery.limit,
      offset: validatedQuery.offset,
    };

    const pendingTransfers = await getPendingBankTransfers(filters);

    res.json({
      success: true,
      data: pendingTransfers,
      count: pendingTransfers.length,
      pagination: {
        limit: validatedQuery.limit,
        offset: validatedQuery.offset,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: error.issues.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    next(error);
  }
};

/**
 * Get bank transfer statistics
 */
export const getBankTransferStatsController = async (req, res, next) => {
  try {
    const stats = await getBankTransferStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};
