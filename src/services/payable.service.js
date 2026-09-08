// src/services/payable.service.js
//
// The other half of the cost side. Until this existed the operator could
// accrue debts — a lodge invoice, an agent's commission — and had no way to
// record ever paying them, so every payable stayed outstanding forever and
// the ageing report would have been fiction.
//
// A payment to a supplier is a lump sum, not a line-by-line settlement: an
// operator pays a lodge for the month and expects it to clear what has been
// owed longest. That is what applySettlement's oldest-due-first ordering does,
// addressed by counterparty rather than by source.

import { and, eq, sql } from 'drizzle-orm';
import { withTenantDb } from '#config/tenantContext.js';
import {
  counterparties,
  obligations,
  allocations,
} from '#models/money.model.js';
import * as money from '#services/money.service.js';
import { decimalToCents, centsToDecimal } from '#utils/money.js';
import logger from '#config/logger.js';

const COUNTERPARTY_NOT_FOUND = 'Counterparty not found';
const NOTHING_OWED =
  'That counterparty has nothing outstanding in that currency';

// Outstanding is amount minus what has been allocated, computed in one
// statement rather than per row — a payables list is exactly where an N+1
// shows up, because it is read most often when the list is longest.
const outstandingExpr = sql`${obligations.amount_cents} - coalesce(sum(${allocations.amount_cents}), 0)`;

const shapeObligation = (row) => ({
  obligation_id: row.id,
  kind: row.kind,
  source_type: row.source_type,
  source_id: row.source_id,
  description: row.description,
  due_on: row.due_on,
  currency: row.currency,
  amount: centsToDecimal(row.amount_cents),
  amount_cents: row.amount_cents,
  outstanding: centsToDecimal(row.outstanding_cents),
  outstanding_cents: row.outstanding_cents,
});

const requireCounterparty = async (tx, counterpartyId) => {
  const [row] = await tx
    .select()
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId))
    .limit(1);

  // RLS makes another tenant's counterparty invisible rather than forbidden,
  // so absent and "belongs to somebody else" are the same answer.
  if (!row) throw new Error(COUNTERPARTY_NOT_FOUND);
  return row;
};

/**
 * What is still owed to one counterparty, oldest due first.
 *
 * Only open obligations with something left: a voided invoice is not owed, and
 * a fully paid one is not either. Both are still in the ledger and neither
 * belongs on a list of what to pay.
 */
export const listPayables = (counterpartyId) =>
  withTenantDb(async (tx) => {
    const counterparty = await requireCounterparty(tx, counterpartyId);

    const rows = await tx
      .select({
        id: obligations.id,
        kind: obligations.kind,
        source_type: obligations.source_type,
        source_id: obligations.source_id,
        description: obligations.description,
        due_on: obligations.due_on,
        currency: obligations.currency,
        amount_cents: obligations.amount_cents,
        outstanding_cents: outstandingExpr.mapWith(Number),
      })
      .from(obligations)
      .leftJoin(allocations, eq(allocations.obligation_id, obligations.id))
      .where(
        and(
          eq(obligations.counterparty_id, counterpartyId),
          eq(obligations.direction, 'payable'),
          eq(obligations.status, 'open')
        )
      )
      .groupBy(obligations.id)
      .having(sql`${outstandingExpr} > 0`)
      .orderBy(obligations.due_on, obligations.created_at);

    // Totalled per currency rather than summed into one number. A lodge
    // invoicing in USD and a guide paid in KES are two different debts, and
    // adding them would produce a figure that is not money.
    const totals = {};
    for (const row of rows) {
      totals[row.currency] =
        (totals[row.currency] ?? 0) + row.outstanding_cents;
    }

    return {
      counterparty_id: counterparty.id,
      counterparty_name: counterparty.name,
      counterparty_type: counterparty.type,
      outstanding_by_currency: Object.entries(totals).map(
        ([currency, cents]) => ({
          currency,
          outstanding: centsToDecimal(cents),
          outstanding_cents: cents,
        })
      ),
      payables: rows.map(shapeObligation),
    };
  });

/**
 * Records money paid to a counterparty and spends it against what they are
 * owed, oldest first.
 *
 * The settlement and its allocations share one transaction. Recorded without
 * allocating, the money would sit unmatched while the invoices still read as
 * outstanding — which is the state this endpoint exists to prevent, not one to
 * create halfway through.
 */
export const payCounterparty = async (counterpartyId, validated) => {
  const { amount, method, currency, occurred_on, reference, notes } = validated;
  const amountCents = decimalToCents(amount);

  const result = await withTenantDb(async (tx) => {
    const counterparty = await requireCounterparty(tx, counterpartyId);
    const settlementCurrency = currency ?? counterparty.default_currency;

    // Checked before recording anything. A payment to somebody who is owed
    // nothing in that currency is almost always a mistyped counterparty or a
    // mistyped currency, and recording it would leave money sitting unmatched
    // for somebody to chase later.
    const [owed] = await tx
      .select({ total: sql`count(*)`.mapWith(Number) })
      .from(obligations)
      .where(
        and(
          eq(obligations.counterparty_id, counterpartyId),
          eq(obligations.direction, 'payable'),
          eq(obligations.status, 'open'),
          eq(obligations.currency, settlementCurrency)
        )
      );

    if (!owed?.total) throw new Error(NOTHING_OWED);

    const settlement = await money.recordSettlement({
      direction: 'out',
      counterpartyId,
      method,
      amountCents,
      currency: settlementCurrency,
      externalReference: reference ?? null,
      occurredAt: occurred_on
        ? new Date(`${occurred_on}T00:00:00Z`)
        : new Date(),
      notes: notes ?? null,
    });

    // Nested withTenantDb reuses this transaction, so the allocations land with
    // the settlement or not at all.
    const applied = await money.applySettlement(settlement.id, {
      counterpartyId,
    });

    return { counterparty, settlement, applied };
  });

  const allocatedCents = result.applied.reduce(
    (sum, a) => sum + a.amount_cents,
    0
  );

  logger.info('[payable] counterparty paid', {
    counterpartyId,
    settlementId: result.settlement.id,
    allocations: result.applied.length,
  });

  return {
    settlement_id: result.settlement.id,
    counterparty_id: result.counterparty.id,
    counterparty_name: result.counterparty.name,
    method: result.settlement.method,
    currency: result.settlement.currency,
    paid: centsToDecimal(amountCents),
    paid_cents: amountCents,

    allocated: centsToDecimal(allocatedCents),
    allocated_cents: allocatedCents,

    // Anything the payment could not spend. Not an error: paying a lodge more
    // than they have invoiced is ordinary, and the balance stays on the
    // settlement for the next invoice rather than being forced somewhere.
    unallocated: centsToDecimal(amountCents - allocatedCents),
    unallocated_cents: amountCents - allocatedCents,

    cleared: result.applied.map((a) => ({
      obligation_id: a.obligation_id,
      amount: centsToDecimal(a.amount_cents),
      amount_cents: a.amount_cents,
    })),
  };
};

export {
  COUNTERPARTY_NOT_FOUND as PAYABLE_COUNTERPARTY_NOT_FOUND,
  NOTHING_OWED,
};
