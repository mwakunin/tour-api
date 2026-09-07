import {
  pgTable,
  uuid,
  text,
  decimal,
  timestamp,
  index,
  pgEnum,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { bookings } from './booking.model.js';
import { user } from './user.model.js';
import { currencyEnum, paymentTransactionStatusEnum } from './enums.model.js';
import { tenants } from './tenant.model.js';

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
    // Tenant discriminator. Added before there is a second operator on
    // purpose — retrofitting this across every table and query later is the
    // expensive migration, and the column costs nothing while there is one row.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

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
    // set null, not the default: deleting a staff account must not take the
    // payment record with it. Who confirmed it is audit history.
    confirmed_by: text('confirmed_by').references(() => user.id, {
      onDelete: 'set null',
    }),

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
    // Every M-Pesa callback looks a payment up by this; it was a sequential
    // scan on a table that only grows.
    checkoutRequestIdx: index('payments_checkout_request_id_idx').on(
      table.checkout_request_id
    ),
    tenantIdIdx: index('payments_tenant_id_idx').on(table.tenant_id),
    // Target for settlements.payment_id, which was the one money-layer
    // reference that could not be tenant-scoped until now.
    tenantScopedId: unique('payments_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    bookingFk: foreignKey({
      name: 'payments_booking_tenant_fk',
      columns: [table.tenant_id, table.booking_id],
      foreignColumns: [bookings.tenant_id, bookings.id],
    }).onDelete('cascade'),
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
