// src/services/money.service.js
//
// The money layer's operations. Deliberately domain-neutral: this file knows
// about counterparties, obligations, settlements and allocations, and nothing
// about tours, lodges or bookings. Callers translate their domain into these
// four nouns.
//
// Every write goes through withTenantDb, so the RLS policies apply and the
// ledger rows land in the SAME transaction as the thing they account for. A
// ledger that can disagree with its subject is worse than no ledger.

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, or, desc, lte, sql } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import {
  tenants,
  obligations,
  settlements,
  allocations,
  ledger_entries,
  fx_rates,
} from '#models/schema.js';
import logger from '#config/logger.js';

const PPM = 1_000_000n;

// Which cash account a settlement method lands in. Card and cash both fall to
// cash_other because neither has a dedicated float we reconcile separately.
const CASH_ACCOUNT = {
  mpesa: 'cash_mpesa',
  pesapal: 'cash_pesapal',
  paystack: 'cash_paystack',
  bank_transfer: 'cash_bank',
  card: 'cash_other',
  cash: 'cash_other',
};

/**
 * Money must be a positive, whole, representable number of cents.
 *
 * The database CHECKs catch negatives and zero, but a fractional or
 * unsafe-integer amount would be stored as-is and then silently mangled by the
 * BigInt conversion in toBaseCents. Rejecting at the boundary keeps the ledger
 * from recording an amount nobody chose.
 */
const assertAmountCents = (amountCents, label) => {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error(
      `[money] ${label} must be a positive safe integer number of cents, ` +
        `received ${JSON.stringify(amountCents)}`
    );
  }
};

// ============= CURRENCY =============

const baseCurrencyOf = async (tx, tenantId) => {
  const [row] = await tx
    .select({ base: tenants.base_currency })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new Error(`[money] tenant ${tenantId} not found`);
  return row.base;
};

/**
 * Most recent rate on or before `onDate`. Rates are not published daily, so
 * asking for an exact-date match would fail every weekend.
 *
 * A tenant's own rate wins over a shared one for the same date — an operator
 * who books at a contracted rate should not be silently repriced.
 */
// Exported so the FX endpoint can answer "which rate would a conversion on
// this date use" with the same ordering the conversion itself applies. A
// second implementation would drift, and the drift would only show as a
// ledger entry nobody can explain.
export const findRate = async (tx, { tenantId, from, to, onDate }) => {
  const [rate] = await tx
    .select()
    .from(fx_rates)
    .where(
      and(
        eq(fx_rates.base_currency, from),
        eq(fx_rates.quote_currency, to),
        lte(fx_rates.as_of, onDate),
        or(eq(fx_rates.tenant_id, tenantId), isNull(fx_rates.tenant_id))
      )
    )
    // NULLS LAST, not `desc(tenant_id)`: Postgres sorts NULLs first in DESC,
    // so the shared rate was beating the tenant's own contracted rate whenever
    // both existed for the same date.
    .orderBy(desc(fx_rates.as_of), sql`${fx_rates.tenant_id} DESC NULLS LAST`)
    .limit(1);
  return rate ?? null;
};

/**
 * Converts to the tenant's base currency for the ledger.
 *
 * BigInt, not Number: amount_cents times rate_ppm overflows IEEE-754 well
 * inside plausible KES amounts — 1e10 cents at 129.45 is already past
 * MAX_SAFE_INTEGER, and the failure is silent rounding rather than an error.
 */
/**
 * Applies a stored rate to an amount, in integer arithmetic throughout.
 *
 * Extracted so the accrual side and the settlement side of an allocation
 * convert identically. Two copies of this would drift, and the drift would
 * surface as an entry group that refuses to balance for reasons nobody can
 * reconstruct.
 */
const applyRate = (amountCents, rate, label) => {
  // rate_ppm is bigint in Postgres but mapped as a number, so a value past the
  // safe-integer range arrives already rounded and BigInt() would faithfully
  // convert the wrong figure. The output check below cannot catch that: a
  // rounded rate still produces a perfectly safe-looking result.
  if (!Number.isSafeInteger(rate.rate_ppm)) {
    throw new Error(
      `[money] fx_rate ${rate.id} has rate_ppm ${rate.rate_ppm}, outside the ` +
        'safe integer range -- it cannot be read losslessly through the ' +
        "current 'number' column mapping."
    );
  }

  const converted =
    (BigInt(Math.trunc(amountCents)) * BigInt(rate.rate_ppm) + PPM / 2n) / PPM;

  // The arithmetic above is BigInt, but the column is mapped as a JS number,
  // so the result has to land inside the safe-integer range or the ledger
  // silently records a figure nobody chose. assertAmountCents guards what goes
  // in; this guards what conversion made of it.
  const result = Number(converted);
  if (!Number.isSafeInteger(result)) {
    throw new Error(
      `[money] converting ${amountCents} ${label} overflows the safe integer ` +
        `range (got ${converted}). The money columns are bigint in Postgres ` +
        'but mapped as numbers; moving them to bigint mode is the fix if ' +
        'amounts this large are real.'
    );
  }
  return result;
};

export const toBaseCents = async (
  tx,
  { tenantId, amountCents, currency, onDate }
) => {
  const base = await baseCurrencyOf(tx, tenantId);
  if (currency === base)
    return { baseAmountCents: amountCents, fxRateId: null };

  const rate = await findRate(tx, {
    tenantId,
    from: currency,
    to: base,
    onDate,
  });
  if (!rate) {
    // Refusing beats inventing a number. A wrong rate is indistinguishable
    // from a right one once it is in the books.
    throw new Error(
      `[money] no ${currency}->${base} rate on or before ${onDate}. ` +
        'Load one into fx_rates before posting in a foreign currency.'
    );
  }

  return {
    baseAmountCents: applyRate(amountCents, rate, `${currency}->${base}`),
    fxRateId: rate.id,
  };
};

// ============= LEDGER =============

/**
 * Writes one balanced entry group. Legs are signed: positive debits, negative
 * credits, and the BASE amounts must net to zero — booking in transaction
 * currency while balancing in base currency is what lets a USD lodge invoice
 * and a KES park fee sit in one group.
 */
export const postLedger = async (
  tx,
  {
    legs,
    occurredAt = new Date(),
    sourceType = null,
    sourceId = null,
    memo = null,
  }
) => {
  const residue = legs.reduce((sum, l) => sum + l.baseAmountCents, 0);
  if (residue !== 0) {
    // Never write an unbalanced group. Discovering it later means auditing
    // every entry since, rather than the one that was wrong.
    throw new Error(
      `[money] refusing to post an unbalanced entry group: base residue ${residue} cents`
    );
  }

  const entryGroupId = randomUUID();
  await tx.insert(ledger_entries).values(
    legs.map((leg) => ({
      tenant_id: currentTenantId(),
      entry_group_id: entryGroupId,
      account: leg.account,
      amount_cents: leg.amountCents,
      currency: leg.currency,
      base_amount_cents: leg.baseAmountCents,
      fx_rate_id: leg.fxRateId ?? null,
      occurred_at: occurredAt,
      source_type: sourceType,
      source_id: sourceId,
      memo,
    }))
  );
  return entryGroupId;
};

// ============= OBLIGATIONS =============

/**
 * The other half of an accrual. Receivables are earned revenue; payables are
 * either an agent's cut or the cost of delivering the trip, and keeping those
 * apart is what makes margin legible rather than a single lump of "costs".
 */
const counterAccountFor = (direction, kind) => {
  if (direction === 'receivable') return 'revenue';
  return kind === 'commission' ? 'commission_expense' : 'cost_of_sales';
};

/**
 * Records money owed, in either direction, and books the accrual.
 *
 * A receivable debits AR and credits revenue; a payable credits AP and debits
 * either cost of sales or commission expense. That accrual is the reason a
 * booking's margin is visible before anybody has paid anything.
 */
export const createObligation = ({
  direction,
  kind,
  counterpartyId = null,
  sourceType = null,
  sourceId = null,
  amountCents,
  currency,
  dueOn = null,
  description = null,
}) =>
  withTenantDb(async (tx) => {
    assertAmountCents(amountCents, 'obligation amount');
    const tenantId = currentTenantId();
    const onDate = (dueOn ?? new Date().toISOString().slice(0, 10)).toString();

    const { baseAmountCents, fxRateId } = await toBaseCents(tx, {
      tenantId,
      amountCents,
      currency,
      onDate,
    });

    const [obligation] = await tx
      .insert(obligations)
      .values({
        tenant_id: tenantId,
        direction,
        kind,
        counterparty_id: counterpartyId,
        source_type: sourceType,
        source_id: sourceId,
        amount_cents: amountCents,
        currency,
        due_on: dueOn,
        description,
        // The rate this accrual was booked at, so a settlement can clear the
        // obligation at the same rate rather than the settlement-day one.
        // Null for a base-currency obligation, which needs no conversion.
        fx_rate_id: fxRateId,
      })
      .returning();

    const counterAccount = counterAccountFor(direction, kind);

    const legs =
      direction === 'receivable'
        ? [
            {
              account: 'accounts_receivable',
              amountCents,
              currency,
              baseAmountCents,
              fxRateId,
            },
            {
              account: counterAccount,
              amountCents: -amountCents,
              currency,
              baseAmountCents: -baseAmountCents,
              fxRateId,
            },
          ]
        : [
            {
              account: counterAccount,
              amountCents,
              currency,
              baseAmountCents,
              fxRateId,
            },
            {
              account: 'accounts_payable',
              amountCents: -amountCents,
              currency,
              baseAmountCents: -baseAmountCents,
              fxRateId,
            },
          ];

    await postLedger(tx, {
      legs,
      sourceType: 'obligation',
      sourceId: obligation.id,
      memo: description,
    });

    return obligation;
  });

/**
 * Voids an obligation and reverses the unsettled part of its accrual.
 *
 * Setting the status alone left the original entry group posted, so a
 * cancelled booking kept its receivable debited and its revenue credited —
 * revenue stayed overstated for work that will never happen.
 *
 * Only the UNALLOCATED amount is reversed. Anything already settled represents
 * money that actually moved; unwinding it here would make the ledger disagree
 * with the bank. That balance is a refund question, handled separately.
 */
export const voidObligation = (obligationId) =>
  withTenantDb(async (tx) => {
    const [obligation] = await tx
      .select()
      .from(obligations)
      .where(eq(obligations.id, obligationId))
      .limit(1)
      .for('update');

    if (!obligation || obligation.status !== 'open') return null;

    const unsettled = await outstandingCentsFor(tx, obligationId);

    const [voided] = await tx
      .update(obligations)
      .set({ status: 'void', updated_at: new Date() })
      .where(eq(obligations.id, obligationId))
      .returning();

    if (unsettled > 0) {
      const onDate = (
        obligation.due_on ?? new Date().toISOString().slice(0, 10)
      )
        .toString()
        .slice(0, 10);
      const { baseAmountCents, fxRateId } = await toBaseCents(tx, {
        tenantId: currentTenantId(),
        amountCents: unsettled,
        currency: obligation.currency,
        onDate,
      });

      const counterAccount = counterAccountFor(
        obligation.direction,
        obligation.kind
      );

      // Mirror image of the accrual in createObligation, for the unsettled
      // portion only.
      const legs =
        obligation.direction === 'receivable'
          ? [
              {
                account: 'accounts_receivable',
                amountCents: -unsettled,
                currency: obligation.currency,
                baseAmountCents: -baseAmountCents,
                fxRateId,
              },
              {
                account: counterAccount,
                amountCents: unsettled,
                currency: obligation.currency,
                baseAmountCents,
                fxRateId,
              },
            ]
          : [
              {
                account: counterAccount,
                amountCents: -unsettled,
                currency: obligation.currency,
                baseAmountCents: -baseAmountCents,
                fxRateId,
              },
              {
                account: 'accounts_payable',
                amountCents: unsettled,
                currency: obligation.currency,
                baseAmountCents,
                fxRateId,
              },
            ];

      await postLedger(tx, {
        legs,
        sourceType: 'obligation_void',
        sourceId: obligationId,
        memo: `Void of ${obligation.description ?? obligationId}`,
      });
    }

    return voided;
  });

/** Outstanding = amount minus what has been allocated. Never stored. */
export const outstandingCentsFor = async (tx, obligationId) => {
  const [row] = await tx
    .select({
      amount: obligations.amount_cents,
      allocated: sql`coalesce(sum(${allocations.amount_cents}), 0)`.mapWith(
        Number
      ),
    })
    .from(obligations)
    .leftJoin(allocations, eq(allocations.obligation_id, obligations.id))
    .where(eq(obligations.id, obligationId))
    .groupBy(obligations.id, obligations.amount_cents);
  if (!row) throw new Error(`[money] obligation ${obligationId} not found`);
  return row.amount - row.allocated;
};

// ============= SETTLEMENTS =============

export const recordSettlement = ({
  direction,
  counterpartyId = null,
  method,
  amountCents,
  currency,
  externalReference = null,
  paymentId = null,
  status = 'completed',
  occurredAt = new Date(),
  notes = null,
}) =>
  withTenantDb(async (tx) => {
    assertAmountCents(amountCents, 'settlement amount');
    const [settlement] = await tx
      .insert(settlements)
      .values({
        tenant_id: currentTenantId(),
        direction,
        counterparty_id: counterpartyId,
        method,
        amount_cents: amountCents,
        currency,
        external_reference: externalReference,
        payment_id: paymentId,
        status,
        occurred_at: occurredAt,
        notes,
      })
      .returning();
    return settlement;
  });

/** How much of a settlement has not yet been attached to an obligation. */
export const unallocatedCentsFor = async (tx, settlementId) => {
  const [row] = await tx
    .select({
      amount: settlements.amount_cents,
      allocated: sql`coalesce(sum(${allocations.amount_cents}), 0)`.mapWith(
        Number
      ),
    })
    .from(settlements)
    .leftJoin(allocations, eq(allocations.settlement_id, settlements.id))
    .where(eq(settlements.id, settlementId))
    .groupBy(settlements.id, settlements.amount_cents);
  if (!row) throw new Error(`[money] settlement ${settlementId} not found`);
  return row.amount - row.allocated;
};

// ============= ALLOCATION =============

/**
 * Attaches part of a settlement to an obligation, and books the cash movement.
 *
 * Three invariants the database cannot express, checked here:
 *   - same currency on both sides
 *   - directions agree: receivable <- in, payable <- out
 *   - neither side is over-allocated
 *
 * The first two are the ones that would otherwise produce books that balance
 * arithmetically while describing something that never happened.
 */
export const allocate = ({
  obligationId,
  settlementId,
  amountCents,
  note = null,
}) =>
  withTenantDb(async (tx) => {
    assertAmountCents(amountCents, 'allocation amount');

    // FOR UPDATE on both sides. The over-allocation checks below are
    // read-then-write, so without locking two concurrent callbacks for the
    // same booking both read the same outstanding amount, both pass, and both
    // insert — the obligation ends up over-settled and the ledger disagrees
    // with the cash. Locking in a fixed order (obligation, then settlement)
    // also keeps two allocations touching the same pair from deadlocking.
    const [obligation] = await tx
      .select()
      .from(obligations)
      .where(eq(obligations.id, obligationId))
      .limit(1)
      .for('update');
    const [settlement] = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.id, settlementId))
      .limit(1)
      .for('update');

    // RLS makes a cross-tenant row invisible rather than forbidden, so a
    // missing row here may mean "belongs to someone else", not "absent".
    if (!obligation)
      throw new Error(`[money] obligation ${obligationId} not found`);
    if (!settlement)
      throw new Error(`[money] settlement ${settlementId} not found`);

    // Rechecked here, under the lock, and not left to whoever selected this
    // obligation earlier: applySettlement picks open obligations in a separate
    // statement, and a void committing in between leaves the accrual reversed
    // while this allocation is still in flight.
    //
    // The over-allocation guard below does not catch it. outstandingCentsFor
    // is amount_cents minus allocations and never consults status, so a voided
    // obligation still reports its full amount outstanding — the guard passes,
    // cash and receivable legs post against a reversed obligation, and the
    // receivable goes negative.
    if (obligation.status !== 'open') {
      throw new Error(
        `[money] obligation ${obligationId} is '${obligation.status}', not open`
      );
    }

    // The settlement side needs the same check. settlements.status defaults
    // to 'pending' and recordSettlement takes whatever status the caller
    // passes, so without this a pending or failed settlement can be allocated:
    // the cash legs below debit cash_* for money that has not arrived and the
    // receivable is reduced against it.
    if (settlement.status !== 'completed') {
      throw new Error(
        `[money] settlement ${settlementId} is '${settlement.status}', not completed`
      );
    }

    if (obligation.currency !== settlement.currency) {
      throw new Error(
        `[money] currency mismatch: obligation is ${obligation.currency}, ` +
          `settlement is ${settlement.currency}`
      );
    }

    const expected = obligation.direction === 'receivable' ? 'in' : 'out';
    if (settlement.direction !== expected) {
      throw new Error(
        `[money] direction mismatch: a ${obligation.direction} is settled by ` +
          `an '${expected}' settlement, not '${settlement.direction}'`
      );
    }

    const obligationLeft = await outstandingCentsFor(tx, obligationId);
    if (amountCents > obligationLeft) {
      throw new Error(
        `[money] over-allocating obligation: ${amountCents} > ${obligationLeft} outstanding`
      );
    }
    const settlementLeft = await unallocatedCentsFor(tx, settlementId);
    if (amountCents > settlementLeft) {
      throw new Error(
        `[money] over-allocating settlement: ${amountCents} > ${settlementLeft} unallocated`
      );
    }

    const [allocation] = await tx
      .insert(allocations)
      .values({
        tenant_id: currentTenantId(),
        obligation_id: obligationId,
        settlement_id: settlementId,
        amount_cents: amountCents,
        note,
      })
      .returning();

    const onDate = (settlement.occurred_at ?? new Date())
      .toISOString()
      .slice(0, 10);
    const { baseAmountCents, fxRateId } = await toBaseCents(tx, {
      tenantId: currentTenantId(),
      amountCents,
      currency: settlement.currency,
      onDate,
    });

    // The obligation side clears at the rate its accrual was booked at, not
    // the settlement-day rate. Valued at the settlement rate, the debit that
    // raised the receivable and the credit that clears it do not cancel in
    // base currency: each entry group still balances on its own, so nothing
    // complains, but the difference stays in accounts_receivable after the
    // obligation is fully paid and reconciles to nothing.
    //
    // Falls back to the settlement rate -- the previous behaviour -- for a
    // base-currency obligation, which has no stored rate, and for one raised
    // before obligations.fx_rate_id existed.
    let accrualBaseCents = baseAmountCents;
    let accrualRateId = fxRateId;

    // Applies whenever the obligation has an accrual rate, including when the
    // settlement resolves to the same rate row. Skipping it there looked like a
    // safe shortcut -- same rate, same answer -- but the telescoping is not
    // about the rate differing, it is about rounding each instalment
    // separately. On the same rate, three parts of a 100001-cent obligation
    // still rounded to one cent less than the single accrual conversion.
    if (obligation.fx_rate_id) {
      const [accrualRate] = await tx
        .select({ id: fx_rates.id, rate_ppm: fx_rates.rate_ppm })
        .from(fx_rates)
        .where(eq(fx_rates.id, obligation.fx_rate_id))
        .limit(1);

      if (accrualRate) {
        // Converted on the CUMULATIVE cleared amount and differenced, not on
        // this allocation alone. Rounding each part separately does not sum to
        // the whole: three 1-cent allocations at 0.4 each convert to 0, 0, 0
        // while the 3-cent accrual converted to 1, leaving a cent in the
        // receivable after it was fully paid. Taking the delta between the
        // cumulative conversions telescopes to exactly the accrued base,
        // whatever the rate and however the payments were split.
        const label = `${obligation.currency} at the accrual rate`;
        const clearedBefore = obligation.amount_cents - obligationLeft;
        accrualBaseCents =
          applyRate(clearedBefore + amountCents, accrualRate, label) -
          applyRate(clearedBefore, accrualRate, label);
        accrualRateId = accrualRate.id;
      }
    }

    const cashAccount = CASH_ACCOUNT[settlement.method] ?? 'cash_other';
    const legs =
      settlement.direction === 'in'
        ? [
            {
              account: cashAccount,
              amountCents,
              currency: settlement.currency,
              baseAmountCents,
              fxRateId,
            },
            {
              account: 'accounts_receivable',
              amountCents: -amountCents,
              currency: settlement.currency,
              baseAmountCents: -accrualBaseCents,
              fxRateId: accrualRateId,
            },
          ]
        : [
            {
              account: 'accounts_payable',
              amountCents,
              currency: settlement.currency,
              baseAmountCents: accrualBaseCents,
              fxRateId: accrualRateId,
            },
            {
              account: cashAccount,
              amountCents: -amountCents,
              currency: settlement.currency,
              baseAmountCents: -baseAmountCents,
              fxRateId,
            },
          ];

    // Taken from what the legs actually leave over, rather than re-derived
    // from the two rates. The residue has the opposite sign for a payable --
    // its obligation leg is positive and its cash leg negative, the reverse of
    // a receivable -- and a single hardcoded sign was therefore right in one
    // direction and doubled the imbalance in the other, so postLedger rejected
    // every payable allocation whose rate had moved. Reading the residue
    // cannot get that backwards.
    const residueCents = legs.reduce((sum, l) => sum + l.baseAmountCents, 0);

    if (residueCents !== 0) {
      // Two different things can leave a residue, and they are not the same
      // fact about the business. On the same rate it is rounding: the
      // settlement side converts each instalment, the obligation side
      // converts the running total, and the two disagree by a cent. On
      // different rates it is a realised gain or loss -- the money was worth
      // more or less in the operator's own currency than when it was booked.
      // Both accounts have been in the enum since 0006 waiting for a writer.
      const residueAccount =
        accrualRateId === fxRateId ? 'rounding' : 'fx_gain_loss';

      // Denominated in base currency, where the amount and the base amount are
      // the same figure: neither a rounding difference nor an FX gain has an
      // amount in the transaction currency. That also satisfies
      // ledger_entries_amount_cents_non_zero, which a leg carrying a zero
      // transaction amount would violate.
      const baseCurrency = await baseCurrencyOf(tx, currentTenantId());
      legs.push({
        account: residueAccount,
        amountCents: -residueCents,
        currency: baseCurrency,
        baseAmountCents: -residueCents,
        fxRateId: null,
      });
    }

    await postLedger(tx, {
      legs,
      occurredAt: settlement.occurred_at ?? new Date(),
      sourceType: 'allocation',
      sourceId: allocation.id,
      memo: note,
    });

    return allocation;
  });

/**
 * Spends a settlement against the caller's open obligations, oldest due first.
 *
 * Partial payment, overpayment and a receipt that clears two invoices at once
 * are all the same walk down this list — which is the whole reason allocations
 * is a table rather than a column on either side.
 */
export const applySettlement = async (
  settlementId,
  { sourceType, sourceId }
) => {
  const targets = await withTenantDb(async (tx) => {
    const [settlement] = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.id, settlementId))
      .limit(1);
    if (!settlement)
      throw new Error(`[money] settlement ${settlementId} not found`);

    const direction = settlement.direction === 'in' ? 'receivable' : 'payable';
    return tx
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.direction, direction),
          eq(obligations.status, 'open'),
          eq(obligations.currency, settlement.currency),
          eq(obligations.source_type, sourceType),
          eq(obligations.source_id, sourceId)
        )
      )
      .orderBy(obligations.due_on, obligations.created_at);
  });

  const made = [];
  for (const obligation of targets) {
    const left = await withTenantDb((tx) =>
      unallocatedCentsFor(tx, settlementId)
    );
    if (left <= 0) break;

    const owed = await withTenantDb((tx) =>
      outstandingCentsFor(tx, obligation.id)
    );
    if (owed <= 0) continue;

    const amount = Math.min(left, owed);
    made.push(
      await allocate({
        obligationId: obligation.id,
        settlementId,
        amountCents: amount,
      })
    );
  }

  if (made.length === 0) {
    // Not an error: money can legitimately arrive before anyone has raised the
    // obligation for it. It stays unallocated and shows on the unmatched
    // receipts worklist rather than being forced somewhere.
    logger.info(
      '[money] settlement recorded but not matched to any obligation',
      {
        settlementId,
        sourceType,
        sourceId,
      }
    );
  }
  return made;
};
