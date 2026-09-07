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

import {
  withTenantDb,
  currentTenantId,
  inTenantTransaction,
} from '#config/tenantContext.js';
import { obligations, counterparties } from '#models/schema.js';
import { decimalToCents } from '#utils/money.js';
import logger from '#config/logger.js';
import * as money from './money.service.js';

const SOURCE = 'booking';

// Basis points to money, in integer arithmetic. 1250 bps of 125000 cents is
// 15625, and the rate is stored as an integer precisely so this multiplication
// never goes near a float — a commission is somebody's income, and a rounding
// error in it is a rounding error in what an agent is paid.
//
// Rounds half up at the last cent rather than truncating, so the operator does
// not systematically underpay by a fraction on every booking.
const commissionCentsFor = (totalCents, rateBps) =>
  Number((BigInt(totalCents) * BigInt(rateBps) + 5000n) / 10000n);

/**
 * Raises the agent's commission for a booking, as a payable.
 *
 * A no-op for a direct booking, which is most of them: no agent, no
 * commission, no obligation. Also a no-op, loudly, for an agent with no rate
 * configured — validation refuses to create one, but a rate cleared afterwards
 * would otherwise silently raise a zero payable that nobody notices until
 * reconciliation.
 *
 * Due on the departure date rather than the booking date: the agent has earned
 * it when the trip runs, and paying commission on a trip that has not happened
 * yet is how an operator ends up chasing refunds from agents.
 */
export const raiseAgentCommission = async (booking) => {
  if (!booking.agent_id) return null;

  const [agent] = await withTenantDb((tx) =>
    tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, booking.agent_id))
      .limit(1)
  );

  if (!agent) {
    logger.error('[bookingLedger] booking names an agent that does not exist', {
      bookingId: booking.id,
      agentId: booking.agent_id,
    });
    return null;
  }

  if (agent.commission_rate_bps === null) {
    logger.error('[bookingLedger] agent has no commission rate configured', {
      bookingId: booking.id,
      agentId: agent.id,
    });
    return null;
  }

  const totalCents = decimalToCents(booking.total_price);
  if (!totalCents || totalCents <= 0) return null;

  const amountCents = commissionCentsFor(totalCents, agent.commission_rate_bps);

  // A rate low enough to round to nothing on a small booking. An obligation of
  // zero is rejected by assertAmountCents anyway, and there is nothing to owe.
  if (amountCents <= 0) return null;

  return money.createObligation({
    direction: 'payable',
    kind: 'commission',
    counterpartyId: agent.id,
    sourceType: SOURCE,
    sourceId: booking.id,
    amountCents,
    currency: booking.currency,
    dueOn: new Date(booking.start_date).toISOString().slice(0, 10),
    description: `Commission ${agent.name} ${booking.booking_reference}`,
  });
};

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
    // Same rule as the settlement path. Outside a transaction the decision
    // stands: a booking must not fail because its accrual did, since that is a
    // reconciliation problem rather than a reason to reject a customer who has
    // committed. Inside one there is no such choice to make -- the transaction
    // is already unusable, and reporting a skipped accrual would be a lie.
    if (inTenantTransaction()) throw error;

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
    // Both branches below decide to carry on. That is only a decision the
    // caller can honour outside a transaction: within one, the statement that
    // raised this has already aborted it, so "carry on" means every following
    // statement fails on a dead transaction and the real cause is buried.
    // Pesapal settles inside the claim's transaction for exactly that
    // atomicity, so it has to hear about this.
    if (inTenantTransaction()) throw error;

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
export const voidBookingObligations = async (bookingId) => {
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
            // Every obligation the booking raised, in either direction: the
            // customer's receivable and the agent's commission both stop being
            // owed when the trip is cancelled. Deliberately not filtered by
            // direction — a separate function for the payable side would be
            // one more pair to keep in step, and the pair that drifts is the
            // one nobody remembers to update.
            //
            // Supplier invoices are untouched: they carry source_type
            // 'supplier_invoice', and whether a lodge still charges for a
            // cancelled booking is their cancellation policy, not ours to
            // assume.
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
    // Rethrown rather than swallowed. Returning [] told the caller the
    // receivables had been dealt with when they were still open, so a
    // cancellation answered success with the books left wrong and nothing to
    // retry from. The caller runs this inside its own transaction, which now
    // rolls the cancellation back with it.
    logger.error('[bookingLedger] failed to void receivables', {
      bookingId,
      error: error.message,
    });
    throw error;
  }
};
