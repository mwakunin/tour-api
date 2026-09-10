import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';

import { db } from '#config/database.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import { tenants, memberships, user } from '#models/schema.js';
import { loadMembership } from '#middleware/membership.middleware.js';

// The point of this table is that a session cookie which reaches the wrong
// operator's hostname finds NOTHING, rather than finding a row that some
// hand-written comparison then has to notice is wrong. So these tests assert
// invisibility, not rejection -- they go through withTenantDb exactly as the
// middleware does, which means they fail if the policy, the role or the
// transaction scoping regresses.

const TENANT_A = '00000000-0000-0000-0000-0000000000c1';
const TENANT_B = '00000000-0000-0000-0000-0000000000c2';

let alice;
let bob;

describe('memberships', () => {
  beforeAll(async () => {
    await db
      .insert(tenants)
      .values([
        {
          id: TENANT_A,
          name: 'Operator A',
          slug: 'mem-tenant-a',
          booking_ref_prefix: 'MA',
        },
        {
          id: TENANT_B,
          name: 'Operator B',
          slug: 'mem-tenant-b',
          booking_ref_prefix: 'MB',
        },
      ])
      .onConflictDoNothing();

    const stamp = Date.now();

    [alice] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `alice-${stamp}@example.com`,
        name: 'Alice',
        role: 'user',
      })
      .returning();

    [bob] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `bob-${stamp}@example.com`,
        name: 'Bob',
        role: 'user',
      })
      .returning();

    // Alice is staff at A and a customer at B -- one login, different standing
    // at each operator. Bob is admin at A only.
    await db.insert(memberships).values([
      { tenant_id: TENANT_A, user_id: alice.id, role: 'staff' },
      { tenant_id: TENANT_B, user_id: alice.id, role: 'customer' },
      { tenant_id: TENANT_A, user_id: bob.id, role: 'admin' },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(memberships)
      .where(inArray(memberships.user_id, [alice.id, bob.id]));
    await db.delete(user).where(inArray(user.id, [alice.id, bob.id]));
    await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
  });

  it('sees only the roles held at the ambient tenant', async () => {
    const atA = await runWithTenant(TENANT_A, () => loadMembership(alice.id));
    expect(atA).toEqual({ tenantId: TENANT_A, roles: ['staff'] });

    const atB = await runWithTenant(TENANT_B, () => loadMembership(alice.id));
    expect(atB).toEqual({ tenantId: TENANT_B, roles: ['customer'] });
  });

  it("cannot see another operator's membership at all", async () => {
    // Bob is admin at A and nothing at B. Read from B, his admin row must not
    // merely fail a check -- it must not come back.
    const atB = await runWithTenant(TENANT_B, () => loadMembership(bob.id));

    expect(atB).toEqual({ tenantId: TENANT_B, roles: [] });
  });

  it('returns no rows for a bare SELECT from the wrong tenant', async () => {
    // The same thing one level down, without the middleware: proof the
    // emptiness comes from the policy and not from how loadMembership filters.
    const rows = await runWithTenant(TENANT_B, () =>
      withTenantDb((tx) =>
        tx.select().from(memberships).where(eq(memberships.user_id, bob.id))
      )
    );

    expect(rows).toHaveLength(0);
  });

  it('refuses to write a membership attributed to another tenant', async () => {
    // WITH CHECK, not USING. Without it a handler could insert a row for
    // another operator and simply be unable to read it back -- which is worse
    // than failing, because the row would still be there.
    await expect(
      runWithTenant(TENANT_A, () =>
        withTenantDb((tx) =>
          tx.insert(memberships).values({
            tenant_id: TENANT_B,
            user_id: bob.id,
            role: 'owner',
          })
        )
      )
    ).rejects.toThrow();

    const leaked = await db
      .select()
      .from(memberships)
      .where(eq(memberships.role, 'owner'));

    expect(leaked).toHaveLength(0);
  });

  it('lets one person hold several roles at one operator', async () => {
    // A guide who also books their own trips. Authorization asks whether the
    // set intersects what a route allows, so both rows have to survive.
    await db
      .insert(memberships)
      .values({ tenant_id: TENANT_A, user_id: alice.id, role: 'customer' });

    const atA = await runWithTenant(TENANT_A, () => loadMembership(alice.id));

    expect(atA.roles.sort()).toEqual(['customer', 'staff']);
  });

  it('returns null outside a tenant context rather than an empty membership', async () => {
    // "Nobody asked" and "asked, holds nothing" are different answers. A guard
    // reading the second must not be handed the first.
    await expect(loadMembership(alice.id)).resolves.toBeNull();
  });

  it('ignores a deactivated membership', async () => {
    await db
      .update(memberships)
      .set({ is_active: false })
      .where(eq(memberships.user_id, bob.id));

    const atA = await runWithTenant(TENANT_A, () => loadMembership(bob.id));
    expect(atA.roles).toEqual([]);

    await db
      .update(memberships)
      .set({ is_active: true })
      .where(eq(memberships.user_id, bob.id));
  });
});
