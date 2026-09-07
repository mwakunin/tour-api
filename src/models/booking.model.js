import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  decimal,
  timestamp,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tours } from './tour.model.js';
import { user } from './user.model.js';
import {
  currencyEnum,
  paymentStatusEnum,
  bookingStatusEnum,
} from './enums.model.js';
import { tenants } from './tenant.model.js';

// ============= BOOKINGS TABLE =============
export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Tenant discriminator. Added before there is a second operator on
    // purpose — retrofitting this across every table and query later is the
    // expensive migration, and the column costs nothing while there is one row.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    // Unique booking reference (e.g., FA-2024-001234)
    booking_reference: varchar('booking_reference', { length: 20 }).notNull(),

    // Foreign keys
    tour_id: uuid('tour_id')
      .references(() => tours.id, { onDelete: 'cascade' })
      .notNull(),
    user_id: text('user_id').references(() => user.id, {
      onDelete: 'set null',
    }),

    // Booking details
    group_size: integer('group_size').notNull(),
    start_date: timestamp('start_date', { withTimezone: true }).notNull(),
    end_date: timestamp('end_date', { withTimezone: true }).notNull(),

    // Price per person at time of booking
    price_per_person: decimal('price_per_person', {
      precision: 10,
      scale: 2,
    }).notNull(),

    // Pricing snapshot (at time of booking)
    total_price: decimal('total_price', { precision: 10, scale: 2 }).notNull(),
    currency: currencyEnum('currency').notNull(),

    // Customer info
    // The trade agent who brought this booking, if it came through one. A
    // counterparty of type 'agent'; their commission is raised as a payable
    // against it when the booking is created.
    //
    // Declared without a Drizzle .references() or foreignKey() on purpose.
    // Doing either means importing counterparties from money.model.js, and
    // money.model.js imports payment.model.js, which imports this file — a
    // cycle, evaluated at module load, in exactly the way that produces
    // "Cannot access X before initialization". The composite foreign key is
    // written by hand in the migration instead, so Postgres still enforces
    // that an agent belongs to the same tenant as the booking.
    agent_id: uuid('agent_id'),

    customer_name: text('customer_name').notNull(),
    customer_email: text('customer_email').notNull(),
    customer_phone: text('customer_phone'),
    country: varchar('country', { length: 100 }), // ✅ ADD THIS LINE

    // Special requests
    special_requests: text('special_requests'),

    // Payment
    payment_status: paymentStatusEnum('payment_status')
      .default('pending')
      .notNull(),
    payment_method: text('payment_method'),
    payment_id: text('payment_id'),

    // Booking status
    status: bookingStatusEnum('status').default('pending').notNull(),

    // Cancellation info
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    cancellation_reason: text('cancellation_reason'),

    // Timestamps
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Indexes for common queries
    bookingReferenceIdx: index('bookings_booking_reference_idx').on(
      table.booking_reference
    ),
    tourIdIdx: index('bookings_tour_id_idx').on(table.tour_id),
    userIdIdx: index('bookings_user_id_idx').on(table.user_id),
    statusIdx: index('bookings_status_idx').on(table.status),
    paymentStatusIdx: index('bookings_payment_status_idx').on(
      table.payment_status
    ),
    startDateIdx: index('bookings_start_date_idx').on(table.start_date),
    createdAtIdx: index('bookings_created_at_idx').on(table.created_at),
    tenantIdIdx: index('bookings_tenant_id_idx').on(table.tenant_id),
    tenantScopedId: unique('bookings_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    // Booking references are generated per operator from their own prefix, so
    // uniqueness is per tenant. Globally unique would mean one operator's
    // counter could collide with another's.
    tenantReferenceUnique: unique('bookings_tenant_id_reference_key').on(
      table.tenant_id,
      table.booking_reference
    ),
    tourFk: foreignKey({
      name: 'bookings_tour_tenant_fk',
      columns: [table.tenant_id, table.tour_id],
      foreignColumns: [tours.tenant_id, tours.id],
    }).onDelete('cascade'),
  })
);

// Relations remain the same...
export const bookingsRelations = relations(bookings, ({ one }) => ({
  tour: one(tours, {
    fields: [bookings.tour_id],
    references: [tours.id],
  }),
  user: one(user, {
    fields: [bookings.user_id],
    references: [user.id],
  }),
}));

// ============= HELPER: GENERATE BOOKING REFERENCE =============
/**
 * Generates a unique booking reference
 * Format: FA-YYYY-NNNNNN
 * Example: FA-2024-001234
 */

// booking_reference is varchar(20) and the format costs 14 characters after
// the prefix (`-YYYY-` plus six timestamp digits and two random), so anything
// longer than six would overflow the column. tenants.booking_ref_prefix allows
// eight, hence the clamp rather than trusting the caller.
const MAX_PREFIX_LENGTH = 6;

/**
 * @param {string} [prefix] the operator's prefix, from
 *   tenants.booking_ref_prefix. Falls back to the env var and then 'FA' so
 *   callers without a tenant context still work.
 */
export const generateBookingReferenceSimple = (prefix) => {
  const raw = prefix || process.env.BOOKING_REF_PREFIX || 'FA';
  // Upper-cased to match getBookingByReference, which upper-cases the lookup:
  // a tenant configured with a lower-case prefix generated references that
  // could never be found again.
  const safePrefix = String(raw).slice(0, MAX_PREFIX_LENGTH).toUpperCase();
  const year = new Date().getFullYear();
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, '0');

  return `${safePrefix}-${year}-${timestamp}${random}`;
};
