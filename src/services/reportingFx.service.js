// src/services/reportingFx.service.js
//
// The KES divisor the reporting queries use to express revenue in USD.
//
// This was the literal 130.0, written out four times — in getRevenueStats, in
// the destination revenue breakdown and in the tour top-performers query.
// Four copies of one number is a set that drifts, and a rate typed into a
// query is out of date the day after it was typed. It now comes from fx_rates,
// which is the table that exists to answer this.
//
// WHY THE CONSTANT SURVIVES AS A FALLBACK, AND WHY IT IS ONLY HERE.
//
// The first attempt seeded a shared USD/KES rate of 130 so the queries could
// stop carrying one. That broke a guard in fx-rates.test.js, and it deserved
// to: fx_rates is the ledger's lookup too, and a seeded 1970 rate means
// toBaseCents silently converts a USD invoice at a number nobody chose,
// instead of refusing. Inventing a rate is worse than failing — for money
// somebody is owed.
//
// A dashboard is not that. It is a display figure, already rounded to two
// decimals, that nobody is paid from. So reporting falls back where the ledger
// refuses, and says so in the log every time it does. The number is in one
// place now instead of four, and an operator who loads a real rate stops
// seeing it without anyone editing a query.
//
// REPORTS ARE IN USD, NOT tenants.base_currency. That was true before this
// change and this does not alter it — base_currency defaults to KES, so
// switching would multiply every figure on the dashboard by about 130. Which
// currency an operator wants their reports in is a product question, not
// something to decide inside a bug fix.

import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { fx_rates } from '#models/schema.js';
import logger from '#config/logger.js';

// The figure the four queries carried. Kept so the dashboards read the same on
// the day this landed as they did the day before, and for no other reason.
export const LEGACY_KES_PER_USD = 130;

const PPM = 1_000_000;

/**
 * How many KES one USD buys, as of today, for reporting only.
 *
 * Deliberately not findRate from money.service: that one runs inside a
 * caller's transaction and returns the whole row for ledger arithmetic. The
 * four lines of `where` they share are not a second opinion about money —
 * nothing here converts an amount anybody is owed.
 */
export const kesPerUsd = async () => {
  const tenantId = currentTenantId();
  const today = new Date().toISOString().slice(0, 10);

  const [rate] = await withTenantDb((tx) =>
    tx
      .select({ ratePpm: fx_rates.rate_ppm })
      .from(fx_rates)
      .where(
        and(
          eq(fx_rates.base_currency, 'USD'),
          eq(fx_rates.quote_currency, 'KES'),
          lte(fx_rates.as_of, today),
          // The operator's own contracted rate, or the shared reference one.
          or(eq(fx_rates.tenant_id, tenantId), isNull(fx_rates.tenant_id))
        )
      )
      // NULLS LAST rather than desc(tenant_id): Postgres sorts NULLs FIRST in
      // DESC, which would let the shared rate beat the tenant's own whenever
      // both exist for the same date. Same trap as findRate.
      .orderBy(desc(fx_rates.as_of), sql`${fx_rates.tenant_id} DESC NULLS LAST`)
      .limit(1)
  );

  if (!rate) {
    logger.warn(
      '[reportingFx] no USD/KES rate on or before today; reporting revenue ' +
        `at the legacy default of ${LEGACY_KES_PER_USD}. POST /api/fx-rates ` +
        'to replace it.',
      { tenantId }
    );
    return LEGACY_KES_PER_USD;
  }

  // A divisor, so the queries read `total_price / <this>` as they did with the
  // literal. Not integer arithmetic, deliberately: these are dashboard
  // aggregates rounded to two decimals, not amounts anybody is owed. Money
  // somebody owes goes through applyRate in money.service, which is integer
  // end to end.
  return rate.ratePpm / PPM;
};
