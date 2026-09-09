// src/services/obligation.service.js
//
// Reading obligations, so a settlement can be matched to one.
//
// WHY THIS EXISTS AT ALL. /settlements/:id/allocations takes an obligation_id,
// and until now nothing could tell you what obligation ids exist. The only
// enumeration was /counterparties/:id/payables, which needs a counterparty —
// so money going OUT to a supplier could be matched from the worklist and
// money coming IN could not, because a booking receivable carries no
// counterparty at all. That is the half of the worklist that fills up.
//
// Read-only, deliberately. Obligations are raised by the thing that caused
// them — a booking, an agent's commission, a supplier's invoice — and an
// endpoint that created one from nothing would be a way to put money in the
// books with no event behind it.

import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { obligations, allocations, counterparties } from '#models/schema.js';
import { centsToDecimal } from '#utils/money.js';

// The same expression payable.service uses, and for the same reason: computed
// in one statement rather than per row, because a list is read most often when
// it is longest.
const outstandingExpr = sql`${obligations.amount_cents} - coalesce(sum(${allocations.amount_cents}), 0)`;

const shape = (row) => ({
  id: row.id,
  direction: row.direction,
  kind: row.kind,
  status: row.status,
  source_type: row.source_type,
  source_id: row.source_id,
  description: row.description,
  due_on: row.due_on,
  currency: row.currency,

  counterparty_id: row.counterparty_id,
  counterparty_name: row.counterparty_name ?? null,

  amount: centsToDecimal(row.amount_cents),
  amount_cents: row.amount_cents,
  outstanding: centsToDecimal(row.outstanding_cents),
  outstanding_cents: row.outstanding_cents,
});

/**
 * Open obligations with something still owed on them.
 *
 * Only ever the unsettled ones: this exists to answer "what could this money
 * be for", and an obligation with nothing outstanding is not a candidate for
 * anything. A caller wanting history has the source record.
 *
 * Ordered by due date, oldest first, matching the order allocate() spends a
 * settlement in — so the list reads in the sequence the money would actually
 * clear. NULLS LAST is explicit because Postgres puts them last in ASC and an
 * undated obligation should sort after dated ones, not before.
 */
export const listOpenObligations = (filters = {}) => {
  const {
    page = 1,
    limit = 20,
    direction,
    currency,
    counterparty_id,
    search,
  } = filters;
  const offset = (page - 1) * limit;

  const conditions = [
    eq(obligations.tenant_id, currentTenantId()),
    eq(obligations.status, 'open'),
  ];

  // Direction matters more here than anywhere else: money in can only clear a
  // receivable, money out only a payable, and offering the wrong side as a
  // candidate is offering a 422.
  if (direction) conditions.push(eq(obligations.direction, direction));

  // A settlement can only clear an obligation in its own currency, so a
  // caller filtering by the settlement's currency gets exactly the rows that
  // could actually take it.
  if (currency) conditions.push(eq(obligations.currency, currency));

  if (counterparty_id) {
    conditions.push(eq(obligations.counterparty_id, counterparty_id));
  }

  if (search) {
    conditions.push(
      or(
        ilike(obligations.description, `%${search}%`),
        ilike(counterparties.name, `%${search}%`)
      )
    );
  }

  return withTenantDb(async (tx) => {
    const rows = await tx
      .select({
        id: obligations.id,
        direction: obligations.direction,
        kind: obligations.kind,
        status: obligations.status,
        source_type: obligations.source_type,
        source_id: obligations.source_id,
        description: obligations.description,
        due_on: obligations.due_on,
        currency: obligations.currency,
        counterparty_id: obligations.counterparty_id,
        counterparty_name: counterparties.name,
        amount_cents: obligations.amount_cents,
        outstanding_cents: outstandingExpr.mapWith(Number),
      })
      .from(obligations)
      .leftJoin(allocations, eq(allocations.obligation_id, obligations.id))
      .leftJoin(
        counterparties,
        eq(counterparties.id, obligations.counterparty_id)
      )
      .where(and(...conditions))
      .groupBy(obligations.id, counterparties.name)
      .having(sql`${outstandingExpr} > 0`)
      .orderBy(
        sql`${obligations.due_on} ASC NULLS LAST`,
        asc(obligations.created_at)
      )
      .limit(limit)
      .offset(offset);

    // Counted over the same grouped, still-outstanding set. A plain count on
    // obligations would include settled ones and report more pages than the
    // list can fill.
    const [totals] = await tx.select({ total: sql`count(*)::int` }).from(
      tx
        .select({ id: obligations.id })
        .from(obligations)
        .leftJoin(allocations, eq(allocations.obligation_id, obligations.id))
        .leftJoin(
          counterparties,
          eq(counterparties.id, obligations.counterparty_id)
        )
        .where(and(...conditions))
        .groupBy(obligations.id)
        .having(sql`${outstandingExpr} > 0`)
        .as('open_obligations')
    );

    return {
      data: rows.map(shape),
      total: Number(totals?.total ?? 0),
      page,
      limit,
    };
  });
};
