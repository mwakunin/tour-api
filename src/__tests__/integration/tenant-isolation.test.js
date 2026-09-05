import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import { tenants, counterparties } from '#models/schema.js';

// Isolation is a property of the database, not of the code that queries it.
// These tests go through the same appDb path a handler would, so they fail if
// the policies, the role, or the transaction scoping regress — a scoped client
// alone would pass while proving nothing.

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

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
  });

  afterAll(async () => {
    await db
      .delete(counterparties)
      .where(eq(counterparties.tenant_id, TENANT_A));
    await db
      .delete(counterparties)
      .where(eq(counterparties.tenant_id, TENANT_B));
    await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    await db.delete(tenants).where(eq(tenants.id, TENANT_B));
    await appPool.end({ timeout: 5 });
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
});
