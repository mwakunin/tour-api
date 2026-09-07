import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import { eq, sql } from 'drizzle-orm';

import { db } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import {
  tenants,
  counterparties,
  obligations,
  settlements,
  allocations,
  ledger_entries,
  fx_rates,
} from '#models/schema.js';
import * as money from '#services/money.service.js';

const TENANT = '00000000-0000-0000-0000-0000000000c3';
const BOOKING = 'cccccccc-0000-0000-0000-00000000c001';

const asTenant = (fn) => runWithTenant(TENANT, fn);

describe('money service', () => {
  beforeAll(async () => {
    await db
      .insert(tenants)
      .values({
        id: TENANT,
        name: 'Money Test Operator',
        slug: 'money-test-operator',
        base_currency: 'KES',
        booking_ref_prefix: 'MT',
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    // Owner connection: fixtures set up state rather than fight the policies.
    await db.delete(ledger_entries).where(eq(ledger_entries.tenant_id, TENANT));
    await db.delete(allocations).where(eq(allocations.tenant_id, TENANT));
    await db.delete(settlements).where(eq(settlements.tenant_id, TENANT));
    await db.delete(obligations).where(eq(obligations.tenant_id, TENANT));
    await db.delete(fx_rates).where(eq(fx_rates.tenant_id, TENANT));
  });

  afterAll(async () => {
    await db.delete(ledger_entries).where(eq(ledger_entries.tenant_id, TENANT));
    await db.delete(allocations).where(eq(allocations.tenant_id, TENANT));
    await db.delete(settlements).where(eq(settlements.tenant_id, TENANT));
    await db.delete(obligations).where(eq(obligations.tenant_id, TENANT));
    await db.delete(fx_rates).where(eq(fx_rates.tenant_id, TENANT));
    await db.delete(counterparties).where(eq(counterparties.tenant_id, TENANT));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
    await appPool.end({ timeout: 5 });
  });

  const receivable = (amountCents = 420000) =>
    asTenant(() =>
      money.createObligation({
        direction: 'receivable',
        kind: 'full',
        sourceType: 'booking',
        sourceId: BOOKING,
        amountCents,
        currency: 'KES',
        dueOn: '2026-10-12',
        description: 'MT-2026-000123',
      })
    );

  const cashIn = (amountCents = 420000) =>
    asTenant(() =>
      money.recordSettlement({
        direction: 'in',
        method: 'mpesa',
        amountCents,
        currency: 'KES',
        externalReference: 'RCP-001',
      })
    );

  it('books an accrual when an obligation is raised', async () => {
    const obligation = await receivable();
    expect(obligation.amount_cents).toBe(420000);

    const legs = await asTenant(() =>
      withTenantDb((tx) => tx.select().from(ledger_entries))
    );
    expect(legs).toHaveLength(2);
    // AR debited, revenue credited — the margin is visible before anyone pays.
    expect(
      legs.find((l) => l.account === 'accounts_receivable').amount_cents
    ).toBe(420000);
    expect(legs.find((l) => l.account === 'revenue').amount_cents).toBe(
      -420000
    );
  });

  it('derives outstanding from allocations rather than storing it', async () => {
    const obligation = await receivable();
    const settlement = await cashIn(126000);
    await asTenant(() =>
      money.allocate({
        obligationId: obligation.id,
        settlementId: settlement.id,
        amountCents: 126000,
      })
    );

    const left = await asTenant(() =>
      withTenantDb((tx) => money.outstandingCentsFor(tx, obligation.id))
    );
    expect(left).toBe(294000);
  });

  it('refuses to allocate across currencies', async () => {
    const obligation = await receivable();
    const usd = await asTenant(() =>
      money.recordSettlement({
        direction: 'in',
        method: 'pesapal',
        amountCents: 126000,
        currency: 'USD',
      })
    );
    await expect(
      asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: usd.id,
          amountCents: 126000,
        })
      )
    ).rejects.toThrow(/currency mismatch/);
  });

  it('refuses to settle a receivable with an outbound settlement', async () => {
    const obligation = await receivable();
    const out = await asTenant(() =>
      money.recordSettlement({
        direction: 'out',
        method: 'mpesa',
        amountCents: 126000,
        currency: 'KES',
      })
    );
    await expect(
      asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: out.id,
          amountCents: 126000,
        })
      )
    ).rejects.toThrow(/direction mismatch/);
  });

  it('refuses to over-allocate either side', async () => {
    const obligation = await receivable(100000);
    const settlement = await cashIn(500000);
    await expect(
      asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 200000,
        })
      )
    ).rejects.toThrow(/over-allocating obligation/);
  });

  it('keeps every entry group balanced in base currency', async () => {
    const obligation = await receivable();
    const settlement = await cashIn(420000);
    await asTenant(() =>
      money.allocate({
        obligationId: obligation.id,
        settlementId: settlement.id,
        amountCents: 420000,
      })
    );

    const unbalanced = await asTenant(() =>
      withTenantDb((tx) =>
        tx
          .select({ group: ledger_entries.entry_group_id })
          .from(ledger_entries)
          .groupBy(ledger_entries.entry_group_id)
          .having(sql`sum(${ledger_entries.base_amount_cents}) <> 0`)
      )
    );
    expect(unbalanced).toHaveLength(0);
  });

  it('refuses to post a foreign-currency entry with no rate loaded', async () => {
    // Refusing beats inventing a rate: a wrong one is indistinguishable from a
    // right one once it is in the books.
    await expect(
      asTenant(() =>
        money.createObligation({
          direction: 'payable',
          kind: 'deposit',
          amountCents: 87000,
          currency: 'USD',
          dueOn: '2026-10-05',
        })
      )
    ).rejects.toThrow(/no USD->KES rate/);
  });

  it('converts a foreign-currency obligation with BigInt precision', async () => {
    await db.insert(fx_rates).values({
      tenant_id: TENANT,
      base_currency: 'USD',
      quote_currency: 'KES',
      rate_ppm: 129450000, // 129.45
      as_of: '2026-10-01',
      source: 'test',
    });

    const obligation = await asTenant(() =>
      money.createObligation({
        direction: 'payable',
        kind: 'deposit',
        amountCents: 87000, // USD 870.00
        currency: 'USD',
        dueOn: '2026-10-05',
        description: 'Mara Serena deposit',
      })
    );

    const legs = await asTenant(() =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(ledger_entries)
          .where(eq(ledger_entries.source_id, obligation.id))
      )
    );
    // 87000 * 129.45 = 11,262,150 cents = KES 112,621.50
    expect(
      legs.find((l) => l.account === 'cost_of_sales').base_amount_cents
    ).toBe(11262150);
    expect(legs.reduce((s, l) => s + l.base_amount_cents, 0)).toBe(0);
  });

  it('spends one settlement across obligations, oldest due first', async () => {
    const deposit = await asTenant(() =>
      money.createObligation({
        direction: 'receivable',
        kind: 'deposit',
        sourceType: 'booking',
        sourceId: BOOKING,
        amountCents: 126000,
        currency: 'KES',
        dueOn: '2026-09-20',
      })
    );
    const balance = await asTenant(() =>
      money.createObligation({
        direction: 'receivable',
        kind: 'balance',
        sourceType: 'booking',
        sourceId: BOOKING,
        amountCents: 294000,
        currency: 'KES',
        dueOn: '2026-10-12',
      })
    );

    const settlement = await cashIn(200000);
    const made = await asTenant(() =>
      money.applySettlement(settlement.id, {
        sourceType: 'booking',
        sourceId: BOOKING,
      })
    );

    expect(made).toHaveLength(2);
    const depositLeft = await asTenant(() =>
      withTenantDb((tx) => money.outstandingCentsFor(tx, deposit.id))
    );
    const balanceLeft = await asTenant(() =>
      withTenantDb((tx) => money.outstandingCentsFor(tx, balance.id))
    );
    expect(depositLeft).toBe(0); // cleared first — earlier due date
    expect(balanceLeft).toBe(220000); // 294000 - the remaining 74000
  });

  it('reverses the unsettled accrual when an obligation is voided', async () => {
    const obligation = await receivable(420000);

    await asTenant(() => money.voidObligation(obligation.id));

    const legs = await asTenant(() =>
      withTenantDb((tx) => tx.select().from(ledger_entries))
    );

    // Accrual plus its reversal: revenue nets to zero for a trip that will
    // not happen, rather than staying credited.
    const revenue = legs
      .filter((l) => l.account === 'revenue')
      .reduce((sum, l) => sum + l.amount_cents, 0);
    const receivableTotal = legs
      .filter((l) => l.account === 'accounts_receivable')
      .reduce((sum, l) => sum + l.amount_cents, 0);
    expect(revenue).toBe(0);
    expect(receivableTotal).toBe(0);
  });

  // A cross-currency obligation raised on one day's rate and settled on
  // another's. createObligation converted at the due-date rate and allocate at
  // the settlement-date rate, so the debit that raised the receivable and the
  // credit that cleared it did not cancel in base currency. Each entry group
  // balanced on its own, so postLedger never complained -- the difference just
  // stayed in accounts_receivable after the obligation was fully paid.
  describe('a rate that moves between accrual and settlement', () => {
    const loadRate = (as_of, ratePpm) =>
      db.insert(fx_rates).values({
        tenant_id: TENANT,
        base_currency: 'USD',
        quote_currency: 'KES',
        rate_ppm: ratePpm,
        as_of,
        source: 'test',
      });

    const usdReceivable = (amountCents, dueOn) =>
      asTenant(() =>
        money.createObligation({
          direction: 'receivable',
          kind: 'full',
          sourceType: 'booking',
          sourceId: BOOKING,
          amountCents,
          currency: 'USD',
          dueOn,
          description: 'USD safari',
        })
      );

    const usdCashIn = (amountCents, occurredAt) =>
      asTenant(() =>
        money.recordSettlement({
          direction: 'in',
          method: 'pesapal',
          amountCents,
          currency: 'USD',
          externalReference: 'RCP-FX',
          occurredAt,
        })
      );

    const baseTotalFor = (legs, account) =>
      legs
        .filter((l) => l.account === account)
        .reduce((sum, l) => sum + l.base_amount_cents, 0);

    it('clears the receivable to zero and books the movement as FX', async () => {
      await loadRate('2026-11-01', 130_000_000); // 130.00 on the due date
      await loadRate('2026-11-20', 135_000_000); // 135.00 when it settles

      // USD 1,000.00 due on the 1st, paid in full on the 20th.
      const obligation = await usdReceivable(100000, '2026-11-01');
      const settlement = await usdCashIn(
        100000,
        new Date('2026-11-20T09:00:00Z')
      );

      // The accrual rate is kept on the obligation; that is what makes the
      // clearing entry cancel the raising one.
      expect(obligation.fx_rate_id).not.toBeNull();

      await asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 100000,
        })
      );

      const legs = await asTenant(() =>
        withTenantDb((tx) => tx.select().from(ledger_entries))
      );

      // Raised at 130 and cleared at 130: nothing left behind.
      expect(baseTotalFor(legs, 'accounts_receivable')).toBe(0);

      // Cash arrived at 135: USD 1,000 became KES 135,000.
      expect(baseTotalFor(legs, 'cash_pesapal')).toBe(13500000);

      // The 5.00 a shilling moved, on 1,000 dollars, is a realised gain --
      // credited, so negative in this sign convention.
      expect(baseTotalFor(legs, 'fx_gain_loss')).toBe(-500000);

      // And the group still balances, which is what makes all three true at
      // once rather than two of them.
      const residue = legs.reduce((sum, l) => sum + l.base_amount_cents, 0);
      expect(residue).toBe(0);
    });

    it('books a loss when the rate moves the other way', async () => {
      await loadRate('2026-11-01', 130_000_000);
      await loadRate('2026-11-20', 127_000_000); // the shilling strengthened

      const obligation = await usdReceivable(100000, '2026-11-01');
      const settlement = await usdCashIn(
        100000,
        new Date('2026-11-20T09:00:00Z')
      );

      await asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 100000,
        })
      );

      const legs = await asTenant(() =>
        withTenantDb((tx) => tx.select().from(ledger_entries))
      );

      expect(baseTotalFor(legs, 'accounts_receivable')).toBe(0);
      expect(baseTotalFor(legs, 'cash_pesapal')).toBe(12700000);
      // Worth 3,000 less than when it was booked: a debit, so positive.
      expect(baseTotalFor(legs, 'fx_gain_loss')).toBe(300000);
      expect(legs.reduce((sum, l) => sum + l.base_amount_cents, 0)).toBe(0);
    });

    it('posts no FX leg when the rate has not moved', async () => {
      await loadRate('2026-11-01', 130_000_000);

      const obligation = await usdReceivable(100000, '2026-11-01');
      const settlement = await usdCashIn(
        100000,
        new Date('2026-11-10T09:00:00Z')
      );

      await asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 100000,
        })
      );

      const legs = await asTenant(() =>
        withTenantDb((tx) => tx.select().from(ledger_entries))
      );

      // Same rate on both dates, so there is no gain to record. A zero-amount
      // leg would violate ledger_entries_amount_cents_non_zero anyway.
      expect(legs.filter((l) => l.account === 'fx_gain_loss')).toHaveLength(0);
      expect(baseTotalFor(legs, 'accounts_receivable')).toBe(0);
    });

    it('books FX on a payable too, not just a receivable', async () => {
      await loadRate('2026-11-01', 130_000_000);
      await loadRate('2026-11-20', 135_000_000);

      // A payable's legs are the mirror of a receivable's: the obligation leg
      // is positive and the cash leg negative. The residue therefore has the
      // opposite sign, and an FX leg with a single hardcoded sign doubled the
      // imbalance instead of cancelling it -- postLedger rejected the
      // allocation outright. Every test above is a receivable, so none of them
      // could have caught it.
      const obligation = await asTenant(() =>
        money.createObligation({
          direction: 'payable',
          kind: 'full',
          sourceType: 'supplier_invoice',
          sourceId: BOOKING,
          amountCents: 100000,
          currency: 'USD',
          dueOn: '2026-11-01',
          description: 'Mara Serena',
        })
      );

      const settlement = await asTenant(() =>
        money.recordSettlement({
          direction: 'out',
          method: 'bank_transfer',
          amountCents: 100000,
          currency: 'USD',
          externalReference: 'PAY-FX',
          occurredAt: new Date('2026-11-20T09:00:00Z'),
        })
      );

      await asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 100000,
        })
      );

      const legs = await asTenant(() =>
        withTenantDb((tx) => tx.select().from(ledger_entries))
      );

      expect(baseTotalFor(legs, 'accounts_payable')).toBe(0);
      expect(baseTotalFor(legs, 'cash_bank')).toBe(-13500000);
      // Paying 5.00 a dollar more than it was booked at is a loss.
      expect(baseTotalFor(legs, 'fx_gain_loss')).toBe(500000);
      expect(legs.reduce((sum, l) => sum + l.base_amount_cents, 0)).toBe(0);
    });

    it('clears exactly when the payment arrives in parts', async () => {
      // A rate whose thirds do not divide evenly: converting each instalment
      // on its own rounds three times and loses what the single accrual
      // conversion kept, so the receivable would not reach zero.
      await loadRate('2026-11-01', 133_333_333);

      const obligation = await usdReceivable(100001, '2026-11-01');
      const accrued = obligation.amount_cents;

      for (const part of [33333, 33334, 33334]) {
        const settlement = await usdCashIn(
          part,
          new Date('2026-11-01T09:00:00Z')
        );
        await asTenant(() =>
          money.allocate({
            obligationId: obligation.id,
            settlementId: settlement.id,
            amountCents: part,
          })
        );
      }

      expect(accrued).toBe(100001);

      const legs = await asTenant(() =>
        withTenantDb((tx) => tx.select().from(ledger_entries))
      );

      // Raised once, cleared in three parts, and still exactly zero.
      expect(baseTotalFor(legs, 'accounts_receivable')).toBe(0);

      // The settlement side converted each instalment and the obligation side
      // converted the running total, so the two disagree by a cent. That is a
      // rounding difference, not a rate movement, and it is booked as one.
      expect(baseTotalFor(legs, 'rounding')).toBe(1);
      expect(legs.filter((l) => l.account === 'fx_gain_loss')).toHaveLength(0);

      expect(legs.reduce((sum, l) => sum + l.base_amount_cents, 0)).toBe(0);
    });

    it('leaves a same-currency obligation untouched', async () => {
      const obligation = await receivable(420000);
      const settlement = await cashIn(420000);

      // No conversion, so no rate to keep and nothing for FX to explain.
      expect(obligation.fx_rate_id).toBeNull();

      await asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 420000,
        })
      );

      const legs = await asTenant(() =>
        withTenantDb((tx) => tx.select().from(ledger_entries))
      );

      expect(legs.filter((l) => l.account === 'fx_gain_loss')).toHaveLength(0);
      expect(baseTotalFor(legs, 'accounts_receivable')).toBe(0);
    });
  });

  it('refuses to allocate a settlement that has not completed', async () => {
    const obligation = await receivable(100000);
    const pending = await asTenant(() =>
      money.recordSettlement({
        direction: 'in',
        method: 'mpesa',
        amountCents: 100000,
        currency: 'KES',
        externalReference: 'RCP-PENDING',
        status: 'pending',
      })
    );

    // recordSettlement takes the status the caller gives it and the column
    // defaults to 'pending', so without this guard the cash legs would debit
    // cash_mpesa for money that has not arrived and reduce the receivable
    // against it.
    await expect(
      asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: pending.id,
          amountCents: 100000,
        })
      )
    ).rejects.toThrow(/not completed/);

    const left = await asTenant(() =>
      withTenantDb((tx) => money.outstandingCentsFor(tx, obligation.id))
    );
    expect(left).toBe(100000);
  });

  it('refuses to allocate against a voided obligation', async () => {
    const obligation = await receivable(100000);
    const settlement = await cashIn(100000);

    await asTenant(() => money.voidObligation(obligation.id));

    // The over-allocation guard cannot catch this on its own:
    // outstandingCentsFor is amount_cents minus allocations and never reads
    // status, so a voided obligation still reports its full amount as
    // outstanding. allocate has to recheck status under its own lock.
    const stillOutstanding = await asTenant(() =>
      withTenantDb((tx) => money.outstandingCentsFor(tx, obligation.id))
    );
    expect(stillOutstanding).toBe(100000);

    await expect(
      asTenant(() =>
        money.allocate({
          obligationId: obligation.id,
          settlementId: settlement.id,
          amountCents: 100000,
        })
      )
    ).rejects.toThrow(/not open/);

    // The void reversed the accrual to zero. Had the allocation gone through
    // it would have credited the receivable again and driven it negative.
    const legs = await asTenant(() =>
      withTenantDb((tx) => tx.select().from(ledger_entries))
    );
    const receivableTotal = legs
      .filter((l) => l.account === 'accounts_receivable')
      .reduce((sum, l) => sum + l.amount_cents, 0);
    expect(receivableTotal).toBe(0);
  });

  it('reverses only the unsettled part, leaving real money alone', async () => {
    const obligation = await receivable(100000);
    const settlement = await cashIn(40000);
    await asTenant(() =>
      money.allocate({
        obligationId: obligation.id,
        settlementId: settlement.id,
        amountCents: 40000,
      })
    );

    await asTenant(() => money.voidObligation(obligation.id));

    const legs = await asTenant(() =>
      withTenantDb((tx) => tx.select().from(ledger_entries))
    );
    // 100,000 accrued, 40,000 genuinely received, so only 60,000 is reversed.
    const revenue = legs
      .filter((l) => l.account === 'revenue')
      .reduce((sum, l) => sum + l.amount_cents, 0);
    expect(revenue).toBe(-40000);

    const unbalanced = await asTenant(() =>
      withTenantDb((tx) =>
        tx
          .select({ group: ledger_entries.entry_group_id })
          .from(ledger_entries)
          .groupBy(ledger_entries.entry_group_id)
          .having(sql`sum(${ledger_entries.base_amount_cents}) <> 0`)
      )
    );
    expect(unbalanced).toHaveLength(0);
  });

  it('leaves an unmatched receipt unallocated rather than forcing it', async () => {
    const settlement = await cashIn(50000);
    const made = await asTenant(() =>
      money.applySettlement(settlement.id, {
        sourceType: 'booking',
        sourceId: '00000000-0000-0000-0000-00000000dead',
      })
    );
    expect(made).toHaveLength(0);

    const left = await asTenant(() =>
      withTenantDb((tx) => money.unallocatedCentsFor(tx, settlement.id))
    );
    expect(left).toBe(50000);
  });
});
