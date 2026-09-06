import {
  pgTable,
  uuid,
  text,
  decimal,
  timestamp,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { bookings } from './booking.model.js';
import { user } from './user.model.js';
import { currencyEnum, paymentTransactionStatusEnum } from './enums.model.js';

export const paymentMethodEnum = pgEnum('payment_method', [
  'mpesa',
  'paystack',
  'pesapal',
  'card',
  'bank_transfer',
  'cash',
]);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    booking_id: uuid('booking_id')
      .references(() => bookings.id, { onDelete: 'cascade' })
      .notNull(),

    amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
    currency: currencyEnum('currency').default('KES').notNull(),
    payment_method: paymentMethodEnum('payment_method').notNull(),

    // M-Pesa specific
    mpesa_receipt_number: text('mpesa_receipt_number'),
    mpesa_phone_number: text('mpesa_phone_number'),
    merchant_request_id: text('merchant_request_id'),
    checkout_request_id: text('checkout_request_id'),

    // Pesapal specific
    pesapal_tracking_id: text('pesapal_tracking_id'),
    pesapal_merchant_reference: text('pesapal_merchant_reference'),
    pesapal_redirect_url: text('pesapal_redirect_url'),

    // Paystack specific
    paystack_reference: text('paystack_reference'),
    paystack_access_code: text('paystack_access_code'),
    paystack_authorization_url: text('paystack_authorization_url'),

    // ✅ NEW: Bank Transfer specific
    receipt_number: text('receipt_number'), // Bank receipt/reference number
    notes: text('notes'), // Admin notes about the payment
    confirmed_by: text('confirmed_by').references(() => user.id),

    status: paymentTransactionStatusEnum('status').default('pending').notNull(),
    response_data: text('response_data'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    bookingIdIdx: index('payments_booking_id_idx').on(table.booking_id),
    statusIdx: index('payments_status_idx').on(table.status),
    paystackRefIdx: index('payments_paystack_ref_idx').on(
      table.paystack_reference
    ),
    // ✅ ADD THESE INDEXES
    pesapalTrackingIdx: index('payments_pesapal_tracking_idx').on(
      table.pesapal_tracking_id
    ),
    pesapalMerchantRefIdx: index('payments_pesapal_merchant_ref_idx').on(
      table.pesapal_merchant_reference
    ),
  })
);

// Relations
export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, {
    fields: [payments.booking_id],
    references: [bookings.id],
  }),
  // ✅ NEW: Add relation to confirming admin
  confirmedBy: one(user, {
    fields: [payments.confirmed_by],
    references: [user.id],
  }),
}));
