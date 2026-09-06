// src/models/enums.model.js
import { pgEnum } from 'drizzle-orm/pg-core';

export const currencyEnum = pgEnum('currency', ['USD', 'KES']);
export const tourStatusEnum = pgEnum('tour_status', [
  'draft',
  'published',
  'archived',
]);
export const durationUnitEnum = pgEnum('duration_unit', [
  'hours',
  'days',
  'weeks',
]);
export const tourCategoryEnum = pgEnum('tour_category', [
  'adventure',
  'cultural',
  'wildlife',
  'beach',
  'luxury',
  'budget',
  'family',
  'honeymoon',
  'group',
  'private',
]);

// ============= BOOKING-SPECIFIC ENUMS =============
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'paid',
  'failed',
  'refunded',
]);

export const bookingStatusEnum = pgEnum('booking_status', [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
]);

export const paymentTransactionStatusEnum = pgEnum('payment_transaction_status', [
  'pending',
  'completed',
  'failed',
]);
