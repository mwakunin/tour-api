// src/validations/payment.validation.js

import { z } from 'zod';

// =====================================================
// PAYMENT METHOD ENUM
// =====================================================

export const paymentMethodEnum = z.enum([
  'mpesa',
  'paystack',
  'pesapal',
  'card',
  'bank_transfer',
  'cash',
]);

export const paymentStatusEnum = z.enum([
  'pending',
  'completed',
  'failed',
  'refunded',
]);

// =====================================================
// M-PESA VALIDATIONS
// =====================================================

export const mpesaInitiateSchema = z
  .object({
    booking_id: z.string().uuid('Invalid booking ID'),
    phone_number: z
      .string()
      .regex(/^254\d{9}$/, 'Phone number must be in format 254XXXXXXXXX')
      .or(
        z
          .string()
          .regex(/^0\d{9}$/, 'Phone number must be in format 07XXXXXXXX')
      ),
    amount: z.number().positive('Amount must be positive').optional(),
    // ✅ Add currency validation for M-Pesa
    currency: z.string().length(3).optional(),
  })
  .refine(
    (data) => {
      // ✅ M-Pesa only works with KES
      if (data.currency && data.currency.toUpperCase() !== 'KES') {
        return false;
      }
      return true;
    },
    {
      message: 'M-Pesa payments are only available for Kenyan Shillings (KES)',
      path: ['currency'],
    }
  );

export const mpesaCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string(),
      ResultCode: z.number(),
      ResultDesc: z.string(),
      CallbackMetadata: z
        .object({
          Item: z.array(
            z.object({
              Name: z.string(),
              Value: z.union([z.string(), z.number()]),
            })
          ),
        })
        .optional(),
    }),
  }),
});

// =====================================================
// PAYSTACK VALIDATIONS
// =====================================================

export const paystackInitiateSchema = z.object({
  booking_id: z.string().uuid('Invalid booking ID'),
  email: z.string().email('Invalid email address'),
  amount: z.number().positive('Amount must be positive').optional(),
  currency: z.string().length(3).default('KES'),
});

export const paystackVerifySchema = z.object({
  reference: z.string().min(1, 'Reference is required'),
});

export const paystackWebhookSchema = z.object({
  event: z.string(),
  data: z.object({
    id: z.number(),
    status: z.string(),
    reference: z.string(),
    amount: z.number(),
    currency: z.string(),
    customer: z.object({
      email: z.string().email(),
    }),
  }),
});

// ✅ ADD THESE SCHEMAS
export const pesapalInitiateSchema = z.object({
  booking_id: z.string().uuid('Invalid booking ID'),
  email: z.string().email('Invalid email address'),
  phone_number: z.string().optional(),
  amount: z.number().positive('Amount must be positive').optional(),
  currency: z.string().length(3).default('KES'),
});

export const pesapalIPNSchema = z.object({
  OrderTrackingId: z.string().min(1, 'Order tracking ID is required'),
  OrderMerchantReference: z.string().min(1, 'Merchant reference is required'),
  OrderNotificationType: z.string().optional(),
});

export const pesapalVerifySchema = z.object({
  orderTrackingId: z.string().min(1, 'Order tracking ID is required'),
});

// =====================================================
// BANK TRANSFER VALIDATIONS
// =====================================================

export const bankTransferConfirmSchema = z.object({
  receipt_number: z
    .string()
    .min(1, 'Receipt number is required')
    .max(255)
    .optional(),
  amount_received: z.number().positive('Amount must be positive').optional(),
  notes: z
    .string()
    .max(1000, 'Notes must be less than 1000 characters')
    .optional(),
});

export const bankTransferQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'paid', 'all']).default('pending'),
});

// =====================================================
// GENERAL PAYMENT VALIDATIONS
// =====================================================

export const paymentInitializeSchema = z
  .object({
    booking_id: z.string().uuid('Invalid booking ID'),
    payment_method: paymentMethodEnum,

    // M-Pesa specific
    phone_number: z
      .string()
      .regex(/^254\d{9}$/)
      .optional(),

    // Paystack specific
    email: z.string().email().optional(),

    // No `amount` here on purpose: the charge is taken from the booking, so a
    // caller cannot choose what to pay. Zod strips it if one is sent anyway.
    currency: z.string().length(3).default('KES'),
  })
  .refine(
    (data) => {
      if (data.payment_method === 'mpesa') return !!data.phone_number;
      if (['paystack', 'pesapal', 'card'].includes(data.payment_method)) {
        // ✅ ADD pesapal
        return !!data.email;
      }
      return true;
    },
    {
      message:
        'Phone number required for M-Pesa, email required for Paystack/Pesapal',
    }
  )
  .refine(
    (data) => {
      if (data.payment_method === 'mpesa') {
        return data.currency.toUpperCase() === 'KES';
      }
      return true;
    },
    {
      message: 'M-Pesa payments are only available for Kenyan Shillings (KES)',
      path: ['currency'],
    }
  );

export const paymentVerifySchema = z
  .object({
    payment_id: z.string().uuid('Invalid payment ID').optional(),
    reference: z.string().optional(),
    checkout_request_id: z.string().optional(),
  })
  .refine(
    (data) => {
      // At least one identifier must be provided
      return data.payment_id || data.reference || data.checkout_request_id;
    },
    {
      message:
        'At least one identifier (payment_id, reference, or checkout_request_id) is required',
    }
  );

export const paymentStatusQuerySchema = z.object({
  booking_id: z.string().uuid('Invalid booking ID'),
});

export const paymentHistoryQuerySchema = z.object({
  user_id: z.number().int().positive().optional(),
  booking_id: z.string().uuid().optional(),
  payment_method: paymentMethodEnum.optional(),
  status: paymentStatusEnum.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  from_date: z.coerce.date().optional(),
  to_date: z.coerce.date().optional(),
});

// =====================================================
// PAYMENT RECORD SCHEMA (for creating payment records)
// =====================================================

export const paymentCreateSchema = z.object({
  booking_id: z.string().uuid('Invalid booking ID'),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().length(3).default('KES'),
  payment_method: paymentMethodEnum,

  // M-Pesa fields
  mpesa_receipt_number: z.string().optional(),
  mpesa_phone_number: z.string().optional(),
  merchant_request_id: z.string().optional(),
  checkout_request_id: z.string().optional(),

  // ✅ Pesapal fields (ADD THESE)
  pesapal_tracking_id: z.string().optional(),
  pesapal_merchant_reference: z.string().optional(),
  pesapal_redirect_url: z.string().url().optional(),

  // Paystack fields
  paystack_reference: z.string().optional(),
  paystack_access_code: z.string().optional(),
  paystack_authorization_url: z.string().url().optional(),

  // Bank transfer fields
  receipt_number: z.string().optional(),
  notes: z.string().optional(),
  confirmed_by: z.string().uuid().optional(),

  status: paymentStatusEnum.default('pending'),
  response_data: z.string().optional(),
});

// =====================================================
// EXPORT VALIDATION FUNCTIONS
// =====================================================

export const validateMpesaInitiate = (data) => mpesaInitiateSchema.parse(data);
export const validateMpesaCallback = (data) => mpesaCallbackSchema.parse(data);

export const validatePaystackInitiate = (data) =>
  paystackInitiateSchema.parse(data);
export const validatePaystackVerify = (data) =>
  paystackVerifySchema.parse(data);
export const validatePaystackWebhook = (data) =>
  paystackWebhookSchema.parse(data);

// ✅ ADD THESE EXPORTS
export const validatePesapalInitiate = (data) =>
  pesapalInitiateSchema.parse(data);
export const validatePesapalIPN = (data) => pesapalIPNSchema.parse(data);
export const validatePesapalVerify = (data) => pesapalVerifySchema.parse(data);

export const validateBankTransferConfirm = (data) =>
  bankTransferConfirmSchema.parse(data);
export const validateBankTransferQuery = (data) =>
  bankTransferQuerySchema.parse(data);

export const validatePaymentInitialize = (data) =>
  paymentInitializeSchema.parse(data);
export const validatePaymentVerify = (data) => paymentVerifySchema.parse(data);
export const validatePaymentStatusQuery = (data) =>
  paymentStatusQuerySchema.parse(data);
export const validatePaymentHistory = (data) =>
  paymentHistoryQuerySchema.parse(data);
export const validatePaymentCreate = (data) => paymentCreateSchema.parse(data);

// =====================================================
// VALIDATION MIDDLEWARE
// =====================================================

export const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const validated = schema.parse({
        ...req.body,
        ...req.query,
        ...req.params,
      });

      // Replace request data with validated data
      req.validatedData = validated;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: error.issues.map((err) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      next(error);
    }
  };
};
