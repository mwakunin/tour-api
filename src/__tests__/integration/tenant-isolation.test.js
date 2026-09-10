import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import {
  tenants,
  counterparties,
  fx_rates,
  bookings,
  tours,
} from '#models/schema.js';
import { createTestTour } from '../helpers/tour.helper.js';

// Isolation is a property of the database, not of the code that queries it.
// These tests go through the same appDb path a handler would, so they fail if
// the policies, the role, or the transaction scoping regress — a scoped client
// alone would pass while proving nothing.

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';
const SHARED_RATE_ID = '00000000-0000-0000-0000-0000000000f1';

describe('tenant isolation (RLS)', () => {
  beforeAll(async () => {
    // Seeded as the owner: creating operators is an owner-plane operation and
    // the runtime role is deliberately not allowed to do it.
    await db
      .insert(tenants)
      .values([
        {
          id: TENANT_A,
          name: 'Tenant A',
          slug: 'rls-tenant-a',
          booking_ref_prefix: 'TA',
        },
        {
          id: TENANT_B,
          name: 'Tenant B',
          slug: 'rls-tenant-b',
          booking_ref_prefix: 'TB',
        },
      ])
      .onConflictDoNothing();

    // A shared reference rate: tenant_id IS NULL, readable by everyone.
    // Written as the owner, because the runtime role must not be able to
    // create one either.
    await db
      .insert(fx_rates)
      .values({
        id: SHARED_RATE_ID,
        tenant_id: null,
        base_currency: 'USD',
        quote_currency: 'KES',
        rate_ppm: 130000000,
        as_of: '2026-01-01',
        source: 'rls-test',
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(fx_rates).where(eq(fx_rates.id, SHARED_RATE_ID));
    await db
      .delete(counterparties)
      .where(eq(counterparties.tenant_id, TENANT_A));
    await db
      .delete(counterparties)
      .where(eq(counterparties.tenant_id, TENANT_B));
    await db.delete(bookings).where(eq(bookings.tenant_id, TENANT_A));
    await db.delete(tours).where(eq(tours.tenant_id, TENANT_A));
    await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    await db.delete(tenants).where(eq(tenants.id, TENANT_B));
    await appPool.end({ timeout: 5 });
  });

  // Why this one exists: a review flagged the ownership exception in
  // booking.controller.js -- `booking.user_id === req.user.id` -- as missing an
  // authorization check, on the grounds that owning a booking does not prove
  // membership in the resolved tenant. True, and irrelevant: the BOOKING's
  // tenancy is what matters, and it is settled before that line runs.
  //
  // booking.service.js reads exclusively through withTenantDb and never the
  // owner connection, and `bookings` carries ENABLE + FORCE ROW LEVEL SECURITY
  // from migration 0010. So a booking that reaches the ownership check is
  // already known to belong to the resolved tenant. There was no test saying
  // so, which is why the question could be asked at all.
  it('hides a booking from every tenant but its own', async () => {
    const tour = await createTestTour({ tenant_id: TENANT_A });

    const [booking] = await db
      .insert(bookings)
      .values({
        tenant_id: TENANT_A,
        booking_reference: `TA-${Date.now()}`.slice(0, 20),
        tour_id: tour.id,
        group_size: 2,
        start_date: new Date('2027-01-10'),
        end_date: new Date('2027-01-13'),
        price_per_person_cents: 120000,
        total_price_cents: 240000,
        currency: 'USD',
        customer_name: 'Alpha Customer',
        customer_email: 'alpha-customer@example.com',
      })
      .returning();

    // Its own tenant sees it.
    const mine = await runWithTenant(TENANT_A, () =>
      withTenantDb((tx) =>
        tx.select().from(bookings).where(eq(bookings.id, booking.id))
      )
    );
    expect(mine).toHaveLength(1);

    // Another tenant does not -- not "sees it and is refused", but cannot
    // retrieve the row at all. That is what makes the ownership comparison in
    // the controller safe: it never runs against a foreign booking, because
    // the fetch that precedes it returns nothing.
    const theirs = await runWithTenant(TENANT_B, () =>
      withTenantDb((tx) =>
        tx.select().from(bookings).where(eq(bookings.id, booking.id))
      )
    );
    expect(theirs).toHaveLength(0);
  });

  it('refuses to query without a tenant context', async () => {
    await expect(
      withTenantDb((tx) => tx.select().from(counterparties))
    ).rejects.toThrow(/outside a tenant context/);
  });

  it('lets a tenant read back what it wrote', async () => {
    await runWithTenant(TENANT_A, () =>
      withTenantDb(async (tx) => {
        await tx.insert(counterparties).values({
          tenant_id: TENANT_A,
          type: 'supplier',
          name: 'Mara Serena Lodge',
          default_currency: 'USD',
        });
      })
    );

    const rows = await runWithTenant(TENANT_A, () =>
      withTenantDb((tx) => tx.select().from(counterparties))
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Mara Serena Lodge');
  });

  it("hides one tenant's rows from another", async () => {
    const rows = await runWithTenant(TENANT_B, () =>
      withTenantDb((tx) => tx.select().from(counterparties))
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a write attributed to another tenant', async () => {
    // WITH CHECK, not USING: without it a handler could insert a row it then
    // could not read back, which is corruption rather than protection.
    //
    // Drizzle wraps driver errors, so the policy violation is on `cause`, not
    // on the top-level message — asserting on the wrapper would pass for any
    // failed insert and prove nothing.
    const error = await runWithTenant(TENANT_A, () =>
      withTenantDb((tx) =>
        tx.insert(counterparties).values({
          tenant_id: TENANT_B,
          type: 'supplier',
          name: 'Smuggled In',
        })
      )
    ).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.cause?.message ?? '').toMatch(/row-level security/i);
    expect(error.cause?.code).toBe('42501'); // insufficient_privilege
  });

  it('shows a tenant only its own tenants row', async () => {
    const rows = await runWithTenant(TENANT_A, () =>
      withTenantDb((tx) => tx.select().from(tenants))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(TENANT_A);
  });

  it('does not leak the setting to a later operation', async () => {
    // set_config(..., true) is transaction-scoped. If it were session-scoped
    // the next borrower of this pooled connection would inherit the tenant.
    const rows = await runWithTenant(TENANT_B, () =>
      withTenantDb((tx) => tx.select().from(counterparties))
    );
    expect(rows).toHaveLength(0);
  });

  it('reuses the ambient transaction when nested', async () => {
    const seen = await runWithTenant(TENANT_A, () =>
      withTenantDb((outer) =>
        withTenantDb((tx) => {
          expect(tx).toBe(outer);
          return tx.select().from(counterparties);
        })
      )
    );
    expect(seen).toHaveLength(1);
  });

  // Shared FX rates are the one asymmetric table: every tenant reads them,
  // no tenant may write them. 0008 said so in a comment but expressed it as a
  // single policy whose USING clause admitted shared rows to UPDATE and
  // DELETE as well as SELECT.
  describe('shared fx rates', () => {
    it('lets a tenant read a shared rate', async () => {
      const rows = await runWithTenant(TENANT_A, () =>
        withTenantDb((tx) =>
          tx.select().from(fx_rates).where(eq(fx_rates.id, SHARED_RATE_ID))
        )
      );
      expect(rows).toHaveLength(1);
    });

    it('does not let a tenant delete a shared rate', async () => {
      await runWithTenant(TENANT_A, () =>
        withTenantDb((tx) =>
          tx.delete(fx_rates).where(eq(fx_rates.id, SHARED_RATE_ID))
        )
      );

      // Read back as the owner: RLS makes the row invisible to the delete
      // rather than raising, so the proof is that it is still there.
      const rows = await db
        .select()
        .from(fx_rates)
        .where(eq(fx_rates.id, SHARED_RATE_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBeNull();
    });

    it('does not let a tenant claim a shared rate as its own', async () => {
      await runWithTenant(TENANT_A, () =>
        withTenantDb((tx) =>
          tx
            .update(fx_rates)
            .set({ tenant_id: TENANT_A })
            .where(eq(fx_rates.id, SHARED_RATE_ID))
        )
      );

      // Had this landed, tenant B's ledger entries citing the rate would
      // reference a row B can no longer read.
      const rows = await db
        .select()
        .from(fx_rates)
        .where(eq(fx_rates.id, SHARED_RATE_ID));
      expect(rows[0].tenant_id).toBeNull();
    });
  });
});
