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
import {
  obligations,
  counterparties,
  tenants,
  bookings,
  payments,
} from '#models/schema.js';
import logger from '#config/logger.js';
import * as money from './money.service.js';
import * as outbox from './ledgerOutbox.service.js';

const SOURCE = 'booking';

// Basis points to money, in integer arithmetic. 1250 bps of 125000 cents is
// 15625, and the rate is stored as an integer precisely so this multiplication
// never goes near a float — a commission is somebody's income, and a rounding
// error in it is a rounding error in what an agent is paid.
//
// Rounds half up at the last cent rather than truncating, so the operator does
// not systematically underpay by a fraction on every booking.
//
// Shared by the agent commission and the deposit split. One helper rather than
// two because a pair of these is a pair that drifts, and the one that drifts is
// always the one nobody remembers to update.
const centsAtBps = (totalCents, rateBps) =>
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

  const already = await openObligationsFor(booking.id, 'payable');
  if (already.length > 0) {
    // Already accrued. Reached by a retry from the outbox, and returning the
    // existing row lets the drain resolve the entry instead of trying forever.
    return already[0];
  }

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

  const totalCents = booking.total_price_cents;
  if (!totalCents || totalCents <= 0) return null;

  const amountCents = centsAtBps(totalCents, agent.commission_rate_bps);

  // A rate low enough to round to nothing on a small booking. An obligation of
  // zero is rejected by assertAmountCents anyway, and there is nothing to owe.
  if (amountCents <= 0) return null;

  try {
    return await money.createObligation({
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
  } catch (error) {
    // Same rule as the receivable: inside an ambient transaction there is
    // nothing to carry on with, and filing an outbox entry on a dead
    // transaction would fail too.
    if (inTenantTransaction()) throw error;

    logger.error('[bookingLedger] failed to raise agent commission', {
      bookingId: booking.id,
      error: error.message,
    });
    await outbox.recordFailure({
      operation: 'agent_commission',
      subjectId: booking.id,
      error,
    });
    return null;
  }
};

/**
 * The open obligations this booking already raised in one direction.
 *
 * Both raisers check this before writing. Without it a retry from the outbox
 * accrues the same revenue a second time, which is a worse failure than the
 * one it is retrying — and the drain would do it on every pass.
 *
 * The check is the clean path; migration 0028's partial unique index is what
 * makes it true when two drains run at once.
 */
const openObligationsFor = (bookingId, direction) =>
  withTenantDb((tx) =>
    tx
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.tenant_id, currentTenantId()),
          eq(obligations.source_type, SOURCE),
          eq(obligations.source_id, bookingId),
          eq(obligations.direction, direction),
          eq(obligations.status, 'open')
        )
      )
  );

/**
 * The tenant's deposit policy, or null when it has none.
 *
 * Null is the default and the answer for every operator today, which is what
 * keeps a booking raising the single full-amount receivable it always did.
 */
const depositPolicy = async () => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        bps: tenants.deposit_percent_bps,
        daysBefore: tenants.balance_due_days_before_departure,
      })
      .from(tenants)
      .where(eq(tenants.id, currentTenantId()))
      .limit(1)
  );

  if (!row?.bps) return null;
  return { bps: row.bps, daysBefore: row.daysBefore };
};

const todayIso = () => new Date().toISOString().slice(0, 10);

// Day arithmetic in UTC on a YYYY-MM-DD string. Deliberately not
// `new Date(iso)` plus setHours: that mixes UTC parsing with local-time
// mutation and shifts the day for anyone behind UTC — the same trap
// tour.validation.js documents for period boundaries.
const isoDaysBefore = (iso, days) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

/**
 * Raises the receivables for a booking.
 *
 * Returns every obligation raised, in the order they fall due — one element
 * with no deposit policy, two with one. An array rather than an obligation
 * because this can legitimately create either, and a return value that is
 * sometimes a row and sometimes a list is the shape callers get wrong.
 *
 * WITH NO POLICY, which is the default: one obligation for the full amount,
 * due on the departure date. Unchanged.
 *
 * WITH ONE: a deposit due today and a balance due `daysBefore` days ahead of
 * departure. The balance is the remainder — total minus deposit, not a second
 * percentage — so the two always sum to the booking exactly and no rounding
 * lands between them. The deposit carries an explicit due date rather than
 * null, because a null due_on sorts LAST in ASC and applySettlement would then
 * spend the customer's first payment on the balance leg.
 *
 * A balance date already in the past — a booking made inside the notice
 * period — is clamped to today rather than backdated. It is genuinely due now;
 * writing an older date would only make it look overdue for longer than it is.
 *
 * Raised at creation, not confirmation, so the outstanding balance is visible
 * from the moment the customer commits. The cost is that an abandoned pending
 * booking leaves an open receivable, which is why cancellation voids it.
 */
export const raiseBookingReceivable = async (booking) => {
  try {
    const already = await openObligationsFor(booking.id, 'receivable');
    if (already.length > 0) {
      // Already accrued. A retry from the outbox lands here, and returning
      // what exists lets the drain resolve the entry rather than post the same
      // revenue again on every pass.
      return already;
    }

    // Read straight off the column now that bookings store cents. This used
    // to be decimalToCents(booking.total_price) — a conversion between two
    // representations of the same money, which is exactly the class of step
    // that loses a cent.
    const amountCents = booking.total_price_cents;
    if (!amountCents || amountCents <= 0) {
      logger.warn(
        '[bookingLedger] skipping receivable for non-positive total',
        {
          bookingId: booking.id,
          totalCents: booking.total_price_cents,
        }
      );
      return [];
    }

    const departureOn = booking.start_date
      ? new Date(booking.start_date).toISOString().slice(0, 10)
      : null;

    const policy = await depositPolicy();
    const depositCents = policy ? centsAtBps(amountCents, policy.bps) : 0;
    const balanceCents = amountCents - depositCents;

    // A percentage that rounds to nothing on a small booking, or one that
    // leaves no balance. Either way the schedule has no second leg, so it is
    // not a schedule — fall back to the single obligation rather than posting
    // one that assertAmountCents would reject anyway.
    if (!policy || depositCents <= 0 || balanceCents <= 0) {
      if (policy) {
        logger.info('[bookingLedger] deposit policy yields no split', {
          bookingId: booking.id,
          amountCents,
          depositCents,
        });
      }

      const full = await money.createObligation({
        direction: 'receivable',
        kind: 'full',
        sourceType: SOURCE,
        sourceId: booking.id,
        amountCents,
        currency: booking.currency,
        dueOn: departureOn,
        description: booking.booking_reference,
      });
      return [full];
    }

    const today = todayIso();
    const balanceOn =
      departureOn && policy.daysBefore !== null
        ? isoDaysBefore(departureOn, policy.daysBefore)
        : departureOn;

    // One transaction around both. A booking that raised a deposit and then
    // failed to raise its balance would understate what the customer owes by
    // the larger half, and nothing downstream would notice — the deposit looks
    // like a complete receivable.
    return await withTenantDb(async () => {
      const deposit = await money.createObligation({
        direction: 'receivable',
        kind: 'deposit',
        sourceType: SOURCE,
        sourceId: booking.id,
        amountCents: depositCents,
        currency: booking.currency,
        dueOn: today,
        description: `${booking.booking_reference} deposit`,
      });

      const balance = await money.createObligation({
        direction: 'receivable',
        kind: 'balance',
        sourceType: SOURCE,
        sourceId: booking.id,
        amountCents: balanceCents,
        currency: booking.currency,
        dueOn: balanceOn && balanceOn < today ? today : balanceOn,
        description: `${booking.booking_reference} balance`,
      });

      return [deposit, balance];
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
    // Logged AND filed. The log was the whole record of this until now, and
    // nobody reads logs looking for revenue that was never accrued.
    await outbox.recordFailure({
      operation: 'booking_receivable',
      subjectId: booking.id,
      error,
    });
    return [];
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
    const amountCents = payment.amount_cents;
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
    if (payment?.id) {
      await outbox.recordFailure({
        operation: 'booking_settlement',
        subjectId: payment.id,
        error,
      });
    }
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

/**
 * Retries the failed ledger writes in the outbox.
 *
 * Lives here rather than in ledgerOutbox.service because it has to call the
 * three functions above, and putting it there would make the two modules
 * import each other.
 *
 * There is no scheduler in this repo — dailySummary.js says as much — so this
 * is driven by an endpoint an admin can hit, or by whatever cron the deploy
 * already runs. Retrying is deliberately something somebody asks for: a failed
 * accrual usually means a rate is missing or a counterparty was deleted, and a
 * loop retrying that every minute produces noise, not books.
 *
 * Each entry is retried in isolation. One that keeps failing must not stop the
 * others, which is the whole reason a batch of these is worth draining at all.
 */
export const drainOutbox = async ({ limit = 50 } = {}) => {
  const entries = await outbox.pendingEntries(limit);
  const result = { attempted: entries.length, resolved: 0, failed: 0 };

  for (const entry of entries) {
    try {
      const resolution = await retryEntry(entry);
      await outbox.resolveEntry(entry.id, resolution);
      result.resolved += 1;
    } catch (error) {
      await outbox.noteAttempt(entry.id, error);
      result.failed += 1;
      logger.warn('[bookingLedger] outbox entry still failing', {
        entryId: entry.id,
        operation: entry.operation,
        subjectId: entry.subject_id,
        error: error.message,
      });
    }
  }

  logger.info('[bookingLedger] outbox drained', result);
  return result;
};

/**
 * Replays one entry, returning how it ended. Throws if it failed again.
 *
 * A subject that has since disappeared resolves rather than retrying forever:
 * a booking deleted in the meantime has no revenue left to accrue, and an
 * entry nobody can ever action is the logged-and-forgotten failure this table
 * was built to replace.
 */
const retryEntry = async (entry) => {
  // Retried INSIDE a transaction, and that is the whole mechanism.
  //
  // The three writers above swallow a failure outside a transaction and
  // rethrow inside one -- `if (inTenantTransaction()) throw error` -- because
  // outside there is a customer to carry on serving and inside there is
  // nothing left to carry on with. Replaying from here wants the second
  // behaviour: a retry that failed has to be told apart from one that found
  // nothing to do, and outside a transaction both arrive as null.
  //
  // They did arrive as both, and this function resolved the entry either way.
  // A failed replay was marked done and the accrual was lost for good, which
  // is the exact failure the outbox exists to prevent -- rebuilt inside the
  // thing meant to fix it. It also meant the receivable path counted one
  // failure twice, once in recordFailure and once in noteAttempt.
  //
  // So: a throw is a failure, and a normal return is success or a genuine
  // no-op. Nothing else needs to be inferred.
  if (entry.operation === 'booking_settlement') {
    try {
      return await withTenantDb(async (tx) => {
        const [payment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.id, entry.subject_id));
        if (!payment) return 'payment no longer exists';

        const [booking] = await tx
          .select()
          .from(bookings)
          .where(eq(bookings.id, payment.booking_id));

        const settlement = await recordBookingSettlement({ payment, booking });
        return settlement ? `settled ${settlement.id}` : 'nothing to settle';
      });
    } catch (error) {
      // 23505 on the settlement index means another path recorded this
      // payment first. Outside a transaction recordBookingSettlement treats
      // that as the guard working; inside one it rethrows before it gets the
      // chance, so the same judgement is made here.
      if (error.cause?.code === '23505') return 'already settled elsewhere';
      throw error;
    }
  }

  return withTenantDb(async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, entry.subject_id));
    if (!booking) return 'booking no longer exists';

    if (entry.operation === 'agent_commission') {
      const commission = await raiseAgentCommission(booking);
      // Null here is a real no-op: no agent, no rate configured, or a rate
      // that rounds to nothing. A failure threw.
      return commission ? `commission ${commission.id}` : 'no commission due';
    }

    const raised = await raiseBookingReceivable(booking);
    // Empty here is a booking with a non-positive total, which has nothing to
    // accrue and will never have. Resolving it beats retrying it forever.
    return raised.length > 0
      ? `raised ${raised.map((row) => row.id).join(', ')}`
      : 'nothing to accrue';
  });
};
