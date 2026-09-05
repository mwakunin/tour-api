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
