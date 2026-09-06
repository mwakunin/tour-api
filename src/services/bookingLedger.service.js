// src/services/bookingLedger.service.js
//
// The seam between the tour domain and the domain-neutral money layer.
//
// money.service.js deliberately knows nothing about bookings, lodges or tours;
// it speaks counterparties, obligations, settlements and allocations. This
// file is where a booking becomes a receivable and an M-Pesa receipt becomes a
// settlement — which is what keeps the money layer portable to school-saas,
// where the same functions will be fed fee invoices instead.
//
// It is intentionally forgiving. A booking must not fail because its ledger
// entry did: the customer's money has already moved, and a failed accrual is a
// reconciliation problem, not a reason to reject the payment. Failures are
// logged loudly and left for the unmatched worklist.

import { and, eq } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { obligations } from '#models/schema.js';
import { decimalToCents } from '#utils/money.js';
import logger from '#config/logger.js';
import * as money from './money.service.js';

const SOURCE = 'booking';

/**
 * Raises the receivable for a booking.
 *
 * Deliberately ONE obligation for the full amount rather than a deposit /
 * balance pair. Partial payment already falls out of the allocations model, so
 * a schedule buys nothing until there is a real per-operator deposit policy
 * (30% now, balance 30 days before departure) to drive it — and inventing one
 * here would bake a number nobody chose into the ledger.
 *
 * Raised at creation, not confirmation, so the outstanding balance is visible
 * from the moment the customer commits. The cost is that an abandoned pending
 * booking leaves an open receivable, which is why cancellation voids it.
 */
export const raiseBookingReceivable = async (booking) => {
  try {
    const amountCents = decimalToCents(booking.total_price);
    if (!amountCents || amountCents <= 0) {
      logger.warn(
        '[bookingLedger] skipping receivable for non-positive total',
        {
          bookingId: booking.id,
          total: booking.total_price,
        }
      );
      return null;
    }

    return await money.createObligation({
      direction: 'receivable',
      kind: 'full',
      sourceType: SOURCE,
      sourceId: booking.id,
      amountCents,
      currency: booking.currency,
      dueOn: booking.start_date
        ? new Date(booking.start_date).toISOString().slice(0, 10)
        : null,
      description: booking.booking_reference,
    });
  } catch (error) {
    logger.error('[bookingLedger] failed to raise receivable', {
      bookingId: booking.id,
      error: error.message,
    });
    return null;
  }
};

/**
 * Turns a completed payment row into a settlement and spends it against the
 * booking's open receivables.
 *
 * `payment_id` links back to the row that carries the provider-specific detail
 * — the M-Pesa receipt number, the Pesapal tracking id — so the money layer
 * never has to grow a column per provider.
 */
export const recordBookingSettlement = async ({ payment, booking }) => {
  try {
    const amountCents = decimalToCents(payment.amount);
    if (!amountCents || amountCents <= 0) {
      logger.warn(
        '[bookingLedger] skipping settlement for non-positive amount',
        {
          paymentId: payment.id,
        }
      );
      return null;
    }

    // One payment, one settlement — enforced by the partial unique index from
    // migration 0012 rather than a read-then-insert check, which two retried
    // callbacks could both pass before either wrote.
    const settlement = await money.recordSettlement({
      direction: 'in',
      method: payment.payment_method,
      amountCents,
      currency: payment.currency,
      externalReference:
        payment.mpesa_receipt_number ||
        payment.pesapal_tracking_id ||
        payment.paystack_reference ||
        payment.receipt_number ||
        null,
      paymentId: payment.id,
      status: 'completed',
      occurredAt: payment.completed_at ?? new Date(),
      notes: booking?.booking_reference ?? null,
    });

    const applied = await money.applySettlement(settlement.id, {
      sourceType: SOURCE,
      sourceId: payment.booking_id,
    });

    logger.info('[bookingLedger] settlement recorded', {
      settlementId: settlement.id,
      paymentId: payment.id,
      allocations: applied.length,
    });
    return settlement;
  } catch (error) {
    // 23505 on the settlement index means a concurrent callback recorded this
    // payment first. That is the guard working, not a failure.
    if (error.cause?.code === '23505') {
      logger.info('[bookingLedger] settlement already recorded for payment', {
        paymentId: payment?.id,
      });
      return null;
    }

    // The money has already moved. Losing the ledger entry is bad; rejecting a
    // payment that Safaricom has already taken is worse.
    logger.error('[bookingLedger] failed to record settlement', {
      paymentId: payment?.id,
      error: error.message,
    });
    return null;
  }
};

/**
 * Voids a cancelled booking's open receivables.
 *
 * Void, not delete: the obligation existed and the accrual was posted, so the
 * row stays and its status changes. Anything already allocated to it is left
 * alone — money that actually arrived is a refund question, not a bookkeeping
 * one, and silently unwinding it here would hide a real balance.
 */
export const voidBookingReceivables = async (bookingId) => {
  try {
    const open = await withTenantDb((tx) =>
      tx
        .select({ id: obligations.id })
        .from(obligations)
        .where(
          and(
            eq(obligations.tenant_id, currentTenantId()),
            eq(obligations.source_type, SOURCE),
            eq(obligations.source_id, bookingId),
            eq(obligations.direction, 'receivable'),
            eq(obligations.status, 'open')
          )
        )
    );

    // Through the money layer, not a bare status update: voiding has to
    // reverse the unsettled part of the accrual, or a cancelled booking keeps
    // its revenue credited for a trip that will not happen.
    const voided = [];
    for (const row of open) {
      const result = await money.voidObligation(row.id);
      if (result) voided.push(result);
    }
    return voided;
  } catch (error) {
    logger.error('[bookingLedger] failed to void receivables', {
      bookingId,
      error: error.message,
    });
    return [];
  }
};
