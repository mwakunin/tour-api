// src/services/fxRate.service.js
//
// The second table the money layer could read but never write. Until this
// existed, every non-base-currency obligation threw by design — toBaseCents
// refuses to invent a rate — so a USD lodge invoice simply could not be
// recorded.
//
// Writes are tenant-owned only. The RLS policy from 0018 has WITH CHECK
// (tenant_id = current_tenant_id()), so a shared reference rate cannot be
// created through this path at all; those stay an owner-plane operation, and
// that is deliberate — one operator must not be able to publish a rate that
// every other operator's books then convert at.

import { and, count, desc, eq } from 'drizzle-orm';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { fx_rates, ledger_entries } from '#models/money.model.js';
import { findRate } from '#services/money.service.js';
import { decimalToPpm, ppmToDecimal } from '#utils/money.js';
import logger from '#config/logger.js';

const NOT_FOUND = 'FX rate not found';
const DUPLICATE = 'A rate for that currency pair and date already exists';
const IN_USE = 'FX rate is referenced by ledger entries and cannot be deleted';

// The stored integer is an implementation detail of the money layer; a client
// asked for "130.25" and should get it back. Both are returned so a caller
// reconciling against the ledger can see the exact figure conversions used.
const shape = (row) =>
  row && {
    ...row,
    rate: ppmToDecimal(row.rate_ppm),
    is_shared: row.tenant_id === null,
  };

export const listFxRates = (filters = {}) => {
  const {
    page = 1,
    limit = 10,
    base_currency,
    quote_currency,
    scope,
  } = filters;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (base_currency) conditions.push(eq(fx_rates.base_currency, base_currency));
  if (quote_currency) {
    conditions.push(eq(fx_rates.quote_currency, quote_currency));
  }
  // RLS already limits reads to this tenant's rates plus the shared ones, so
  // 'all' needs no predicate. 'own' narrows further, and is spelled out rather
  // than left to the policy because "which of these did we load ourselves" is
  // a different question from "which can we see".
  if (scope === 'own')
    conditions.push(eq(fx_rates.tenant_id, currentTenantId()));

  const where = conditions.length ? and(...conditions) : undefined;

  return withTenantDb(async (tx) => {
    const rows = await tx
      .select()
      .from(fx_rates)
      .where(where)
      .orderBy(desc(fx_rates.as_of), desc(fx_rates.created_at))
      .limit(limit)
      .offset(offset);

    const [totals] = await tx
      .select({ total: count() })
      .from(fx_rates)
      .where(where);

    return {
      data: rows.map(shape),
      total: Number(totals?.total ?? 0),
      page,
      limit,
    };
  });
};

export const getFxRateById = async (id) => {
  const [row] = await withTenantDb((tx) =>
    tx.select().from(fx_rates).where(eq(fx_rates.id, id)).limit(1)
  );

  if (!row) throw new Error(NOT_FOUND);
  return shape(row);
};

export const createFxRate = async (validated) => {
  const { rate, ...rest } = validated;
  // Decimal string to parts per million with integer arithmetic; the helper
  // rejects anything that rounds to zero or leaves the safe-integer range,
  // which is the only place a bad rate can still be caught cheaply.
  const rate_ppm = decimalToPpm(rate);

  try {
    const [created] = await withTenantDb((tx) =>
      tx
        .insert(fx_rates)
        .values({
          ...rest,
          rate_ppm,
          // After the spread, so caller input cannot set it — and so a rate
          // can never be created as a shared one through this endpoint.
          tenant_id: currentTenantId(),
        })
        .returning()
    );

    logger.info('[fxRate] loaded', {
      fxRateId: created.id,
      pair: `${created.base_currency}->${created.quote_currency}`,
      asOf: created.as_of,
    });

    return shape(created);
  } catch (error) {
    // 23505 on fx_rates_tenant_pair_date_unique: one rate per pair per day.
    // Answered as a conflict rather than a 500, because loading the same day
    // twice is an ordinary mistake and the caller needs to know it was refused
    // rather than silently ignored.
    if (error.cause?.code === '23505') throw new Error(DUPLICATE);
    throw error;
  }
};

/**
 * The rate a conversion on `on_date` would actually use.
 *
 * Goes through money.service's findRate rather than reimplementing its
 * ordering: most recent on or before the date, the tenant's own rate beating a
 * shared one for the same day. A second implementation would drift, and the
 * drift would surface as a ledger entry nobody can account for.
 */
export const resolveFxRate = async ({
  base_currency,
  quote_currency,
  on_date,
}) => {
  const row = await withTenantDb((tx) =>
    findRate(tx, {
      tenantId: currentTenantId(),
      from: base_currency,
      to: quote_currency,
      onDate: on_date,
    })
  );

  if (!row) throw new Error(NOT_FOUND);
  return shape(row);
};

/**
 * Deletes a rate only while nothing has been converted at it.
 *
 * ledger_entries.fx_rate_id is ON DELETE SET NULL, so deleting a referenced
 * rate would succeed and quietly erase which rate a past conversion used —
 * leaving base amounts in the books with no way to explain them. Refused
 * instead.
 */
export const removeFxRate = (id) =>
  withTenantDb(async (tx) => {
    const [existing] = await tx
      .select({ id: fx_rates.id })
      .from(fx_rates)
      .where(eq(fx_rates.id, id))
      .limit(1);

    if (!existing) throw new Error(NOT_FOUND);

    const [used] = await tx
      .select({ total: count() })
      .from(ledger_entries)
      .where(eq(ledger_entries.fx_rate_id, id));

    if (Number(used?.total ?? 0) > 0) throw new Error(IN_USE);

    // Shared rates are invisible to UPDATE and DELETE under 0018's policies,
    // so this only ever removes a rate this tenant loaded. A shared one
    // reaches the NOT_FOUND path above instead, which is the right answer:
    // from the tenant's side it is not theirs to remove.
    const [deleted] = await tx
      .delete(fx_rates)
      .where(
        and(eq(fx_rates.id, id), eq(fx_rates.tenant_id, currentTenantId()))
      )
      .returning();

    if (!deleted) throw new Error(NOT_FOUND);

    logger.info('[fxRate] deleted', { fxRateId: id });
    return shape(deleted);
  });

export {
  NOT_FOUND as FX_RATE_NOT_FOUND,
  DUPLICATE as FX_RATE_DUPLICATE,
  IN_USE as FX_RATE_IN_USE,
};
