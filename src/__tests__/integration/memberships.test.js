import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';

import app from '../../app.js';
import redis from '#config/redis.js';
import { db } from '#config/database.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import { tenants, memberships, user, session } from '#models/schema.js';
import { loadMembership } from '#middleware/membership.middleware.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import {
  createAuthenticatedAdminAgent,
  createAuthenticatedAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';

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

describe('authorization comes from the membership, over HTTP', () => {
  let adminAgent;
  let testAdmin;
  let adminSessionId;

  beforeAll(async () => {
    const auth = await createAuthenticatedAdminAgent(app);
    adminAgent = auth.agent;
    testAdmin = auth.user;
    adminSessionId = auth.sessionId;
  });

  afterAll(async () => {
    await deleteTestUser(testAdmin.id);
    await cleanupTestSession(redis, adminSessionId);
    await redis.quit();
  });

  it("will not let an admin mutate a user who is not this operator's", async () => {
    // The `user` table is Better Auth's: global, no tenant_id, no RLS. So
    // updateUser(id) and deleteUser(id) reach every operator's users, and the
    // actor check alone -- "are you an admin here" -- says nothing about
    // whether the TARGET belongs here.
    const [outsider] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `outsider-${Date.now()}@example.com`,
        name: 'Belongs To Another Operator',
        role: 'user',
      })
      .returning();

    // No membership anywhere near the seeded tenant this admin administers.
    await adminAgent
      .put(`/api/users/${outsider.id}`)
      .send({ name: 'Renamed by a stranger' })
      .expect(404);

    await adminAgent.delete(`/api/users/${outsider.id}`).expect(404);

    // 404 rather than 403 on purpose: a 403 would confirm the id names a real
    // account, which is what an admin at another operator must not be able to
    // probe for. And the row must still be there.
    const [stillThere] = await db
      .select()
      .from(user)
      .where(eq(user.id, outsider.id));

    expect(stillThere).toBeDefined();
    expect(stillThere.name).toBe('Belongs To Another Operator');

    await db.delete(user).where(eq(user.id, outsider.id));
  });

  it('lets a user with no membership still update their own profile', async () => {
    // Self-service is exempt from the membership check, and the exemption is
    // load-bearing: sign-up creates no membership today, so requiring one here
    // would lock every new user out of their own account.
    //
    // The membership is removed explicitly rather than relying on the helper
    // not to create one -- the helper deliberately grants one, because that is
    // what production looks like, so the odd case has to be built on purpose.
    const { agent, user: fresh } = await createAuthenticatedAgent(app, redis);

    await db.delete(memberships).where(eq(memberships.user_id, fresh.id));

    const held = await runWithTenant(SEED_TENANT_ID, () =>
      loadMembership(fresh.id)
    );
    expect(held.roles).toEqual([]);

    await agent
      .put(`/api/users/${fresh.id}`)
      .send({ name: 'Renamed Myself' })
      .expect(200);

    await deleteTestUser(fresh.id);
  });

  it("will not force-logout a user who is not this operator's", async () => {
    // forceLogout takes :userId straight from the path and hands it to
    // revokeUserSessions, which indexes Better Auth's global user table. An
    // admin at one operator could otherwise log out another operator's users
    // at will -- denial of service across a tenancy boundary.
    const [outsider] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `logout-outsider-${Date.now()}@example.com`,
        name: 'Not Ours',
        role: 'user',
      })
      .returning();

    await adminAgent
      .post(`/api/auth/force-logout/${outsider.id}`)
      .expect(404);

    await db.delete(user).where(eq(user.id, outsider.id));
  });

  it("force-logs-out a user who is this operator's member", async () => {
    // This path answered 500 to every request it ever received --
    // auth.api.revokeUserSessions ships with better-auth's admin plugin and no
    // plugins are configured. There was no test, so the endpoint was dead and
    // looked fine. Asserting the rows actually go is the point; a 200 alone
    // would have passed against a handler that did nothing.
    const { agent, user: member } = await createAuthenticatedAgent(app, redis);

    const before = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, member.id));
    expect(before.length).toBeGreaterThan(0);

    await adminAgent.post(`/api/auth/force-logout/${member.id}`).expect(200);

    const after = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, member.id));
    expect(after).toHaveLength(0);

    // And the session is genuinely dead, not merely deleted from a table
    // nothing reads.
    await agent.get('/api/users/me').expect(401);

    await deleteTestUser(member.id);
  });

  it('revoking the membership revokes admin, without touching the session', async () => {
    await adminAgent.get('/api/counterparties').expect(200);

    // What an operator does when somebody leaves. The row stays so the record
    // of who could once act survives; is_active is what stops them acting.
    await db
      .update(memberships)
      .set({ is_active: false })
      .where(eq(memberships.user_id, testAdmin.id));

    // Same agent, same cookie, same still-valid session. Authentication did
    // not change -- authority did, and that is the separation the memberships
    // table exists to make possible. Under user.role this would have needed a
    // write to the Better Auth row and a re-sign-in to take effect.
    await adminAgent.get('/api/counterparties').expect(403);

    await db
      .update(memberships)
      .set({ is_active: true })
      .where(eq(memberships.user_id, testAdmin.id));

    await adminAgent.get('/api/counterparties').expect(200);
  });
});
