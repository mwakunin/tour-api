// src/services/settlement.service.js
//
// The unmatched receipts worklist.
//
// money.service has referred to this in a comment since the money layer
// landed: a settlement that matches no obligation is not an error, because
// money legitimately arrives before anybody raises the invoice for it, and it
// "stays unallocated and shows on the unmatched receipts worklist rather than
// being forced somewhere". There was no worklist. There was a log line.
//
// This is that worklist, and the way to clear it: an M-Pesa receipt whose
// account reference was mistyped, a bank transfer that arrived before the
// invoice, a supplier payment made against an invoice nobody had entered yet.
// All of them are the same operation — attaching a settlement to an obligation
// — which is why allocations were the centre of the money layer from the
// start.

import { and, eq, sql } from 'drizzle-orm';
import { withTenantDb } from '#config/tenantContext.js';
import {
  counterparties,
  obligations,
  settlements,
  allocations,
} from '#models/money.model.js';
import * as money from '#services/money.service.js';
import { decimalToCents, centsToDecimal } from '#utils/money.js';
import logger from '#config/logger.js';

const SETTLEMENT_NOT_FOUND = 'Settlement not found';
const OBLIGATION_NOT_FOUND = 'Obligation not found';
const NOTHING_LEFT = 'That settlement has nothing left to allocate';
const NOTHING_OWED = 'That obligation has nothing left outstanding';

// Both sides of a match are "amount minus what has been allocated", from
// opposite ends of the same table.
const unallocatedExpr = sql`${settlements.amount_cents} - coalesce(sum(${allocations.amount_cents}), 0)`;

const shape = (row) => ({
  settlement_id: row.id,
  direction: row.direction,
  method: row.method,
  currency: row.currency,
  occurred_at: row.occurred_at,
  external_reference: row.external_reference,
  notes: row.notes,
  counterparty_id: row.counterparty_id,
  counterparty_name: row.counterparty_name ?? null,

  amount: centsToDecimal(row.amount_cents),
  amount_cents: row.amount_cents,
  unallocated: centsToDecimal(row.unallocated_cents),
  unallocated_cents: row.unallocated_cents,
});

/**
 * Money that has moved and is not yet accounted against anything.
 *
 * Oldest first: a receipt nobody has matched for three weeks is the one worth
 * looking at, not the one that arrived this morning.
 */
export const listUnmatched = (filters = {}) => {
  const { page = 1, limit = 10, direction, counterparty_id } = filters;
  const offset = (page - 1) * limit;

  const conditions = [
    // Only money that actually moved. A pending or failed settlement is not
    // unmatched, it is unfinished.
    eq(settlements.status, 'completed'),
  ];
  if (direction) conditions.push(eq(settlements.direction, direction));
  if (counterparty_id) {
    conditions.push(eq(settlements.counterparty_id, counterparty_id));
  }

  return withTenantDb(async (tx) => {
    const base = () =>
      tx
        .select({
          id: settlements.id,
          direction: settlements.direction,
          method: settlements.method,
          currency: settlements.currency,
          occurred_at: settlements.occurred_at,
          external_reference: settlements.external_reference,
          notes: settlements.notes,
          counterparty_id: settlements.counterparty_id,
          counterparty_name: counterparties.name,
          amount_cents: settlements.amount_cents,
          unallocated_cents: unallocatedExpr.mapWith(Number),
        })
        .from(settlements)
        .leftJoin(allocations, eq(allocations.settlement_id, settlements.id))
        .leftJoin(
          counterparties,
          eq(counterparties.id, settlements.counterparty_id)
        )
        .where(and(...conditions))
        .groupBy(settlements.id, counterparties.name)
        .having(sql`${unallocatedExpr} > 0`);

    const rows = await base()
      .orderBy(settlements.occurred_at, settlements.created_at)
      .limit(limit)
      .offset(offset);

    // Counted over the same filtered query as a subquery. Unallocated is an
    // aggregate, so counting the table instead would report rows the HAVING
    // clause had already removed.
    const [totals] = await tx
      .select({ total: sql`count(*)`.mapWith(Number) })
      .from(base().as('unmatched'));

    return {
      data: rows.map(shape),
      total: Number(totals?.total ?? 0),
      page,
      limit,
    };
  });
};

/**
 * Attaches an unmatched settlement to an obligation.
 *
 * The amount is optional, and defaults to as much as both sides can take.
 * Somebody clearing a worklist means "match these", and making them work out
 * the smaller of two numbers by hand is how the wrong one gets typed.
 *
 * Everything else is money.allocate's to refuse: a currency mismatch, a
 * direction that does not agree, an obligation that is not open, and
 * over-allocating either side. This does not re-implement those checks — a
 * second copy would drift, and the drift would be a ledger entry nobody can
 * account for.
 */
export const matchSettlement = async (settlementId, validated) => {
  const { obligation_id, amount, note = null } = validated;

  const allocation = await withTenantDb(async (tx) => {
    const [settlement] = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.id, settlementId))
      .limit(1);

    // RLS makes another tenant's row invisible rather than forbidden, so
    // absent and "belongs to somebody else" are the same answer.
    if (!settlement) throw new Error(SETTLEMENT_NOT_FOUND);

    const [obligation] = await tx
      .select()
      .from(obligations)
      .where(eq(obligations.id, obligation_id))
      .limit(1);

    if (!obligation) throw new Error(OBLIGATION_NOT_FOUND);

    const left = await money.unallocatedCentsFor(tx, settlementId);
    if (left <= 0) throw new Error(NOTHING_LEFT);

    const owed = await money.outstandingCentsFor(tx, obligation_id);
    if (owed <= 0) throw new Error(NOTHING_OWED);

    const amountCents = amount ? decimalToCents(amount) : Math.min(left, owed);

    return money.allocate({
      obligationId: obligation_id,
      settlementId,
      amountCents,
      note,
    });
  });

  logger.info('[settlement] matched by hand', {
    settlementId,
    obligationId: obligation_id,
    amountCents: allocation.amount_cents,
  });

  const [remaining] = await withTenantDb((tx) =>
    tx
      .select({
        id: settlements.id,
        direction: settlements.direction,
        method: settlements.method,
        currency: settlements.currency,
        occurred_at: settlements.occurred_at,
        external_reference: settlements.external_reference,
        notes: settlements.notes,
        counterparty_id: settlements.counterparty_id,
        amount_cents: settlements.amount_cents,
        unallocated_cents: unallocatedExpr.mapWith(Number),
      })
      .from(settlements)
      .leftJoin(allocations, eq(allocations.settlement_id, settlements.id))
      .where(eq(settlements.id, settlementId))
      .groupBy(settlements.id)
  );

  return {
    allocation_id: allocation.id,
    obligation_id,
    matched: centsToDecimal(allocation.amount_cents),
    matched_cents: allocation.amount_cents,
    settlement: shape(remaining),
  };
};

export {
  SETTLEMENT_NOT_FOUND,
  OBLIGATION_NOT_FOUND,
  NOTHING_LEFT,
  NOTHING_OWED,
};
