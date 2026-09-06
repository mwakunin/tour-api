import { z } from 'zod';
import { emailSchema, phoneSchema } from './common.js';
import { toDateKey } from './tour.validation.js';

export const bookingCreateSchema = z
  .object({
    tour_id: z.string().uuid('Invalid tour ID'),
    user_id: z.string().min(1, 'User ID is required'),
    selected_tier_index: z
      .number()
      .int()
      .min(0, 'Please select a pricing package')
      .optional(),
    group_size: z
      .number()
      .int()
      .min(1, 'At least 1 person required')
      .max(20, 'Maximum 20 people allowed'),
    start_date: z.coerce.date(),
    end_date: z.coerce.date(),

    // Pricing - ✅ Make optional since service calculates them
    price_per_person: z
      .number()
      .positive('Price per person must be positive')
      .optional(),
    total_price: z.number().positive('Total price must be positive').optional(),
    // Constrained to the currency enum the column actually accepts;
    // any other three-letter code was a 400 deferred into a 500.
    currency: z.enum(['USD', 'KES']).default('KES'),

    // Customer details
    customer_name: z.string().min(1, 'Customer name is required').max(200),
    customer_email: emailSchema,
    customer_phone: phoneSchema.optional(),
    country: z.string().min(2, 'Country is required').max(100),
    special_requests: z.string().max(1000).optional(),

    // status and payment_status are deliberately NOT accepted here. They were,
    // and createBooking spreads validated input straight into the insert — so a
    // client could POST status:'confirmed', payment_status:'paid' and receive a
    // confirmed, paid booking without paying for it. Both are set by the
    // service; they change only through the payment flows and the admin update
    // schema.
  })
  .refine((data) => data.end_date > data.start_date, {
    message: 'End date must be after start date',
    path: ['end_date'],
  })
  .refine(
    (data) => {
      // Date-only keys, lexicographically — the same comparison tour
      // availability uses. A local-midnight Date boundary compared against a
      // UTC-parsed start_date shifts by the server's offset, so the same
      // booking was valid or not depending on where the process ran.
      const startKey = toDateKey(data.start_date);
      const todayKey = toDateKey(new Date());
      return startKey !== null && startKey >= todayKey;
    },
    {
      message: 'Start date cannot be in the past',
      path: ['start_date'],
    }
  )
  .refine(
    (data) => {
      if (data.price_per_person && data.total_price) {
        const calculatedTotal = data.price_per_person * data.group_size;
        return Math.abs(calculatedTotal - data.total_price) < 0.01;
      }
      return true; // Skip validation if prices not provided
    },
    {
      message: 'Total price must equal price per person × group size',
      path: ['total_price'],
    }
  );

export const bookingUpdateFields = z.object({
  // Booking details
  group_size: z.number().int().min(1).max(20).optional(),
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
  // Pricing
  price_per_person: z.number().positive().optional(),
  total_price: z.number().positive().optional(),
  currency: z.enum(['USD', 'KES']).optional(),
  // Customer info
  customer_name: z.string().min(1).max(200).optional(),
  customer_email: emailSchema.optional(),
  customer_phone: phoneSchema.optional(),
  country: z.string().min(2).max(100).optional(),
  special_requests: z.string().max(1000).optional(),
  // Status
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']).optional(),
  payment_method: z.string().max(50).optional(),
  payment_id: z.string().optional(),
  // Cancellation
  cancellation_reason: z.string().max(500).optional(),
  cancelled_at: z.coerce.date().optional(),
});

export const bookingUpdateSchema = bookingUpdateFields
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return data.end_date > data.start_date;
      }
      return true;
    },
    {
      message: 'End date must be after start date',
      path: ['end_date'],
    }
  )
  .refine(
    (data) => {
      if (data.price_per_person && data.total_price && data.group_size) {
        const calculatedTotal = data.price_per_person * data.group_size;
        return Math.abs(calculatedTotal - data.total_price) < 0.01;
      }
      return true;
    },
    {
      message: 'Total price must equal price per person × group size',
      path: ['total_price'],
    }
  );

// Narrower schema for the customer-facing self-service update endpoint —
// only the fields a regular user is allowed to edit on their own booking.
export const bookingCustomerEditableSchema = bookingUpdateFields.pick({
  customer_name: true,
  customer_email: true,
  customer_phone: true,
  country: true,
  special_requests: true,
});

/**
 * Admin-only re-pricing of a booking agreed off-site. Only the rate is accepted:
 * the total is derived from it server-side, so the two can never disagree.
 */
export const bookingPriceAdjustmentSchema = z.object({
  price_per_person: z
    .number({ error: 'Price per person must be a number' })
    .positive('Price per person must be positive'),
});

export const bookingQuerySchema = z.object({
  // Pagination
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  offset: z.coerce.number().int().min(0).optional(),

  // Filters
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']).optional(),
  tour_id: z.string().uuid().optional(),
  user_id: z.string().min(1).optional(), // for filtering bookings by user
  booking_reference: z.string().optional(),

  // Customer filters
  customer_email: emailSchema.optional(),
  customer_name: z.string().optional(),
  country: z.string().optional(),

  // Date filters
  start_date_from: z.coerce.date().optional(),
  start_date_to: z.coerce.date().optional(),
  end_date_from: z.coerce.date().optional(),
  end_date_to: z.coerce.date().optional(),
  created_at_from: z.coerce.date().optional(),
  created_at_to: z.coerce.date().optional(),

  // Price filters
  min_price: z.coerce.number().positive().optional(),
  max_price: z.coerce.number().positive().optional(),
  currency: z.enum(['USD', 'KES']).optional(),

  // Sorting
  sort_by: z
    .enum(['created_at', 'start_date', 'total_price', 'booking_reference'])
    .default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),

  // Search
  search: z.string().optional(),
});

export const bookingCancelSchema = z.object({
  cancellation_reason: z
    .string()
    .min(10, 'Please provide a reason (min 10 characters)')
    .max(500),
});

export const bookingPaymentUpdateSchema = z.object({
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']),
  payment_method: z.string().max(50).optional(),
  payment_id: z.string().optional(),
});

export const validateBooking = (data) => {
  return bookingCreateSchema.parse(data);
};

export const validateBookingUpdate = (data) => {
  return bookingUpdateSchema.parse(data);
};

export const validateBookingQuery = (data) => bookingQuerySchema.parse(data);
export const validateBookingCancel = (data) => bookingCancelSchema.parse(data);
export const validateBookingPaymentUpdate = (data) =>
  bookingPaymentUpdateSchema.parse(data);
