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

export const paymentTransactionStatusEnum = pgEnum(
  'payment_transaction_status',
  ['pending', 'completed', 'failed']
);

// ============= TENANCY =============
// Daraja requires the transaction type to match the shortcode kind: a Paybill
// takes CustomerPayBillOnline, a Till takes CustomerBuyGoodsOnline, and the
// wrong one fails the STK push. It is therefore per-operator, not per-deploy.
export const mpesaShortcodeTypeEnum = pgEnum('mpesa_shortcode_type', [
  'paybill',
  'till',
]);

export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'suspended',
]);

// ============= MONEY LAYER =============
// These enums belong to the portable money module. They are deliberately
// domain-neutral — no "lodge", no "booking", no "tour" — so the same tables
// can carry supplier payables here and school fee arrears in school-saas.

export const counterpartyTypeEnum = pgEnum('counterparty_type', [
  'customer',
  'supplier',
  'agent',
  'staff',
  'authority',
  'other',
]);

// Which way the money is owed, from the tenant's point of view.
export const obligationDirectionEnum = pgEnum('obligation_direction', [
  'receivable',
  'payable',
]);

export const obligationKindEnum = pgEnum('obligation_kind', [
  'deposit',
  'balance',
  'full',
  'commission',
  'refund',
  'fee',
  'adjustment',
]);

// What a failed ledger write was trying to do, so the outbox can retry it.
//
// The operation and the row it concerns, never the arguments it was called
// with. A serialised payload replayed an hour later writes figures that were
// true when it was captured; re-reading the booking writes what is true now.
export const ledgerOutboxOperationEnum = pgEnum('ledger_outbox_operation', [
  'booking_receivable',
  'agent_commission',
  'booking_settlement',
]);

// Lifecycle only. Whether an obligation is settled is DERIVED from its
// allocations and never stored — see the note in money.model.js.
export const obligationStatusEnum = pgEnum('obligation_status', [
  'open',
  'void',
  'written_off',
]);

export const settlementDirectionEnum = pgEnum('settlement_direction', [
  'in',
  'out',
]);

export const settlementStatusEnum = pgEnum('settlement_status', [
  'pending',
  'completed',
  'failed',
  'reversed',
]);

// Chart of accounts. Small and fixed for v1 — if tenants ever need their own
// accounts this becomes a table, but a migration is cheaper than the bugs a
// free-text account column invites.
export const ledgerAccountEnum = pgEnum('ledger_account', [
  'cash_mpesa',
  'cash_pesapal',
  'cash_paystack',
  'cash_bank',
  'cash_other',
  'accounts_receivable',
  'accounts_payable',
  'revenue',
  'cost_of_sales',
  'commission_expense',
  'fx_gain_loss',
  'rounding',
]);
