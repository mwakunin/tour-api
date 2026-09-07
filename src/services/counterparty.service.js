// src/services/counterparty.service.js
//
// The other side of the ledger. Until this existed the money layer could only
// describe money coming in: counterparties had no writer, so there were no
// lodges to owe, no agents to pay commission to, and a booking's P&L showed
// revenue against nothing.
//
// Deliberately uncached. Every other list service in this codebase caches,
// but these are admin-only reads of a low-cardinality table, and a cache here
// would buy nothing while adding an invalidation path to get wrong — the class
// of bug that produced the stale-statistics and cross-tenant-key findings.

import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { counterparties } from '#models/money.model.js';
import { validateCounterpartyMerged } from '#validations/counterparty.validation.js';
import logger from '#config/logger.js';

const NOT_FOUND = 'Counterparty not found';

export const listCounterparties = (filters = {}) => {
  const { page = 1, limit = 10, type, is_active, search } = filters;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (type) conditions.push(eq(counterparties.type, type));
  if (is_active !== undefined) {
    conditions.push(eq(counterparties.is_active, is_active));
  }
  if (search) {
    const term = `%${search}%`;
    // ilike, not like: like is case-sensitive in Postgres, which is the bug
    // searchTours and the blog search both had.
    conditions.push(
      or(
        ilike(counterparties.name, term),
        ilike(counterparties.email, term),
        ilike(counterparties.phone, term)
      )
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;

  return withTenantDb(async (tx) => {
    const rows = await tx
      .select()
      .from(counterparties)
      .where(where)
      .orderBy(desc(counterparties.created_at))
      .limit(limit)
      .offset(offset);

    const [totals] = await tx
      .select({ total: count() })
      .from(counterparties)
      .where(where);

    return { data: rows, total: Number(totals?.total ?? 0), page, limit };
  });
};

export const getCounterpartyById = async (id) => {
  const [row] = await withTenantDb((tx) =>
    tx.select().from(counterparties).where(eq(counterparties.id, id)).limit(1)
  );

  // RLS makes another tenant's row invisible rather than forbidden, so absent
  // and "belongs to someone else" are the same answer here, on purpose.
  if (!row) throw new Error(NOT_FOUND);
  return row;
};

export const createCounterparty = async (validated) => {
  const [created] = await withTenantDb((tx) =>
    tx
      .insert(counterparties)
      .values({
        ...validated,
        // Assigned after the spread so caller input cannot set it. Not
        // exploitable today -- the spread is Zod output and the schema strips
        // unknown keys -- but the ordering is what guarantees that.
        tenant_id: currentTenantId(),
      })
      .returning()
  );

  logger.info('[counterparty] created', {
    counterpartyId: created.id,
    type: created.type,
  });

  return created;
};

export const updateCounterparty = async (id, validated) => {
  const updated = await withTenantDb(async (tx) => {
    // Read, merge, validate, write — in one transaction, and with the row
    // locked, so the state being judged is the state being written. The cross
    // field rules are about a whole counterparty, and a patch is not one: on
    // its own {"type":"agent"} says nothing about a commission rate, and
    // {"commission_rate_bps":500} says nothing about the type.
    const [current] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, id))
      .limit(1)
      .for('update');

    if (!current) throw new Error(NOT_FOUND);

    validateCounterpartyMerged({ ...current, ...validated });

    const [row] = await tx
      .update(counterparties)
      .set({
        ...validated,
        tenant_id: currentTenantId(),
        updated_at: new Date(),
      })
      .where(eq(counterparties.id, id))
      .returning();

    return row;
  });

  if (!updated) throw new Error(NOT_FOUND);

  logger.info('[counterparty] updated', { counterpartyId: id });
  return updated;
};

/**
 * Deactivates rather than deletes when the counterparty has history.
 *
 * obligations and settlements both reference (tenant_id, counterparty_id) with
 * ON DELETE RESTRICT, so the database refuses to remove a lodge that has ever
 * been invoiced. That is the correct answer -- deleting it would orphan the
 * accounting -- so the restriction is translated into a deactivation rather
 * than surfaced as a foreign-key error.
 *
 * @returns {{ deleted: boolean, counterparty: object }}
 */
export const removeCounterparty = async (id) => {
  try {
    const [deleted] = await withTenantDb((tx) =>
      tx.delete(counterparties).where(eq(counterparties.id, id)).returning()
    );

    if (!deleted) throw new Error(NOT_FOUND);

    logger.info('[counterparty] deleted', { counterpartyId: id });
    return { deleted: true, counterparty: deleted };
  } catch (error) {
    if (error.message === NOT_FOUND) throw error;

    // 23503: foreign_key_violation -- it is referenced by an obligation or a
    // settlement, so it has history worth keeping.
    if (error.cause?.code !== '23503') throw error;

    const counterparty = await updateCounterparty(id, { is_active: false });

    logger.info('[counterparty] deactivated instead of deleted', {
      counterpartyId: id,
    });

    return { deleted: false, counterparty };
  }
};

export { NOT_FOUND as COUNTERPARTY_NOT_FOUND };
