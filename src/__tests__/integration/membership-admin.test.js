import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq, and, notInArray, inArray } from 'drizzle-orm';

import app from '../../app.js';
import redis from '#config/redis.js';
import { db } from '#config/database.js';
import { memberships, user } from '#models/schema.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import {
  createAuthenticatedAdminAgent,
  createAuthenticatedAgent,
  deleteTestUser,
  deleteTestAdmin,
  cleanupTestSession,
} from '../helpers/auth.helper.js';

// The endpoints the /users/:id 409 tells administrators to use: an account may
// be shared with another operator and is not theirs to delete, so removing
// somebody is a membership operation.

let adminAgent;
let testAdmin;
let adminSessionId;

describe('membership administration', () => {
  beforeAll(async () => {
    const auth = await createAuthenticatedAdminAgent(app);
    adminAgent = auth.agent;
    testAdmin = auth.user;
    adminSessionId = auth.sessionId;
  });

  afterAll(async () => {
    await deleteTestAdmin(testAdmin.id);
    await cleanupTestSession(redis, adminSessionId);
    await redis.quit();
  });

  it('lists this operator’s members with their names', async () => {
    const response = await adminAgent.get('/api/memberships').expect(200);

    const mine = response.body.data.find((row) => row.user_id === testAdmin.id);
    expect(mine).toBeDefined();
    expect(mine.role).toBe('admin');
    expect(mine.email).toBe(testAdmin.email);
  });

  it('promotes a customer to staff, then revokes it', async () => {
    // Sign-up grants `customer` and nothing else -- there is no self-service
    // route to authority -- so becoming staff is an act by an administrator.
    const { user: recruit } = await createAuthenticatedAgent(app, redis);

    const granted = await adminAgent
      .post('/api/memberships')
      .send({ user_id: recruit.id, role: 'staff' })
      .expect(201);

    expect(granted.body.data.role).toBe('staff');
    expect(granted.body.data.is_active).toBe(true);

    const revoked = await adminAgent
      .delete(`/api/memberships/${granted.body.data.id}`)
      .expect(200);

    // Deactivated, not deleted: the row is the record that they once held this
    // here, which is what an audit needs after somebody leaves.
    expect(revoked.body.data.is_active).toBe(false);

    const [still] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, granted.body.data.id));
    expect(still).toBeDefined();
    expect(still.is_active).toBe(false);

    await deleteTestUser(recruit.id);
  });

  it('reactivates rather than duplicating when a revoked role is re-granted', async () => {
    const { user: rehired } = await createAuthenticatedAgent(app, redis);

    const first = await adminAgent
      .post('/api/memberships')
      .send({ user_id: rehired.id, role: 'staff' })
      .expect(201);

    await adminAgent
      .delete(`/api/memberships/${first.body.data.id}`)
      .expect(200);

    const second = await adminAgent
      .post('/api/memberships')
      .send({ user_id: rehired.id, role: 'staff' })
      .expect(201);

    // Same row. The unique constraint on (tenant, user, role) would refuse a
    // second one anyway, and reusing it keeps created_at as the date they
    // first held the role.
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.is_active).toBe(true);

    const rows = await db
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.user_id, rehired.id), eq(memberships.role, 'staff'))
      );
    expect(rows).toHaveLength(1);

    await deleteTestUser(rehired.id);
  });

  it('will not revoke the last active administrator', async () => {
    // An operator with nobody who can grant a membership cannot recover
    // without a hand-written INSERT, and the mistake is one click.
    const [mine] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, testAdmin.id),
          eq(memberships.role, 'admin')
        )
      );

    // Every other admin at the seeded tenant is stood down for the duration,
    // so this one really is the last. The backfill left a good number.
    const others = await db
      .update(memberships)
      .set({ is_active: false })
      .where(
        and(
          eq(memberships.tenant_id, SEED_TENANT_ID),
          eq(memberships.role, 'admin'),
          eq(memberships.is_active, true)
        )
      )
      .returning({ id: memberships.id });

    await db
      .update(memberships)
      .set({ is_active: true })
      .where(eq(memberships.id, mine.id));

    try {
      const response = await adminAgent
        .delete(`/api/memberships/${mine.id}`)
        .expect(409);

      expect(response.body.error).toBe('Last administrator');

      // Still able to act, which is the whole point of refusing.
      await adminAgent.get('/api/memberships').expect(200);
    } finally {
      for (const row of others) {
        await db
          .update(memberships)
          .set({ is_active: true })
          .where(eq(memberships.id, row.id));
      }
    }
  });

  it('does not let two concurrent revocations both remove the last admins', async () => {
    // The race the transaction/locking fix closes: revokeMembership used to
    // read the target, count remaining admins, and write the deactivation in
    // three SEPARATE transactions. Two admins revoked at the same moment could
    // each complete their count-check before either write landed, each seeing
    // "somebody else is still active", and both deactivate -- leaving zero.
    // Locking is what serialises the two requests instead of letting them
    // race past the same stale read.
    const second = await createAuthenticatedAdminAgent(app);

    try {
      const [mine] = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, testAdmin.id),
            eq(memberships.role, 'admin')
          )
        );
      const [theirs] = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, second.user.id),
            eq(memberships.role, 'admin')
          )
        );

      // Stand down every OTHER admin at the seeded tenant, so exactly these
      // two are active -- the scenario where the race actually bites.
      const others = await db
        .update(memberships)
        .set({ is_active: false })
        .where(
          and(
            eq(memberships.tenant_id, SEED_TENANT_ID),
            eq(memberships.role, 'admin'),
            eq(memberships.is_active, true),
            notInArray(memberships.id, [mine.id, theirs.id])
          )
        )
        .returning({ id: memberships.id });

      try {
        const [respA, respB] = await Promise.all([
          adminAgent.delete(`/api/memberships/${mine.id}`),
          second.agent.delete(`/api/memberships/${theirs.id}`),
        ]);

        // Exactly one wins and one is refused, in either order -- concurrency
        // does not guarantee which. Both succeeding is the bug this exists to
        // catch: the tenant would be left with no active administrator at
        // all, and nobody left who could grant one back.
        const statuses = [respA.status, respB.status].sort();
        expect(statuses).toEqual([200, 409]);

        const remainingAdmins = await db
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenant_id, SEED_TENANT_ID),
              eq(memberships.role, 'admin'),
              eq(memberships.is_active, true)
            )
          );
        expect(remainingAdmins).toHaveLength(1);
      } finally {
        for (const row of others) {
          await db
            .update(memberships)
            .set({ is_active: true })
            .where(eq(memberships.id, row.id));
        }
        // Whichever of the two lost the race is reactivated too, so this
        // test does not leave testAdmin without standing for the tests after
        // it.
        await db
          .update(memberships)
          .set({ is_active: true })
          .where(eq(memberships.id, mine.id));
      }
    } finally {
      await deleteTestAdmin(second.user.id);
      await cleanupTestSession(redis, second.sessionId);
    }
  });

  it('does not turn two concurrent grants of the same role into a 500', async () => {
    // grantMembership used to select for an existing row and insert in a
    // separate transaction. Two grants of the same role at the same moment
    // both observed "no row yet" and both inserted, and the unique constraint
    // on (tenant, user, role) turned one perfectly valid grant into a 500.
    // The upsert makes the constraint the serialisation point instead of a
    // failure, so both requests succeed and exactly one row exists.
    const [fresh] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `grant-race-${Date.now()}@example.com`,
        name: 'Grant Race',
        role: 'user',
      })
      .returning();

    try {
      const [respA, respB] = await Promise.all([
        adminAgent
          .post('/api/memberships')
          .send({ user_id: fresh.id, role: 'staff' }),
        adminAgent
          .post('/api/memberships')
          .send({ user_id: fresh.id, role: 'staff' }),
      ]);

      expect([respA.status, respB.status]).toEqual([201, 201]);

      const rows = await db
        .select()
        .from(memberships)
        .where(eq(memberships.user_id, fresh.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(true);
      expect(rows[0].role).toBe('staff');
    } finally {
      await db.delete(user).where(eq(user.id, fresh.id));
    }
  });

  it('drops a revoked member from the list and the lookup, not from reach', async () => {
    // getAllUsers used to join every membership regardless of is_active, so
    // someone who left an operator was still a row in that operator's own
    // user directory -- name, email and all. fetchUserById had the matching
    // gap: isTenantMember answers "were they ever a member", which is the
    // right question for update/delete (the /users/:id 409 sends an admin
    // here specifically to act on somebody's account after they are gone) and
    // the wrong one for a directory of who currently works here.
    const { user: former } = await createAuthenticatedAgent(app, redis);

    await db
      .update(memberships)
      .set({ is_active: false })
      .where(eq(memberships.user_id, former.id));

    try {
      const list = await adminAgent.get('/api/users?limit=200').expect(200);
      expect(list.body.users.map((row) => row.id)).not.toContain(former.id);

      const lookup = await adminAgent
        .get(`/api/users/${former.id}`)
        .expect(404);
      expect(lookup.body.error).toBe('User not found');

      // Not gone from what an admin may DO, though -- update and delete stay
      // on the unscoped check, deliberately, so a revoked account can still
      // be cleaned up rather than becoming unreachable the moment it is
      // revoked.
      await adminAgent
        .put(`/api/users/${former.id}`)
        .send({ name: 'Renamed After Leaving' })
        .expect(200);
      await adminAgent.delete(`/api/users/${former.id}`).expect(200);
    } finally {
      await db.delete(memberships).where(eq(memberships.user_id, former.id));
      await db.delete(user).where(eq(user.id, former.id));
    }
  });

  it('filters by the membership held here, not the legacy global user.role', async () => {
    // The column the old filter compared against. A user.role of 'admin' with
    // no matching membership role at this tenant is exactly what
    // eq(user.role, role) would have wrongly matched -- and it is a real
    // shape, not a contrived one: it is what every account created before
    // this whole PR looks like, since nothing backfilled memberships.role
    // from it.
    const stamp = Date.now();
    const [decoy] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `decoy-${stamp}@example.com`,
        name: 'Legacy Admin, Not Really',
        role: 'admin',
      })
      .returning();

    try {
      await db.insert(memberships).values({
        tenant_id: SEED_TENANT_ID,
        user_id: decoy.id,
        role: 'customer',
      });

      // Scoped with `search` to just this one email, not a page of
      // whatever else this tenant has accumulated: the seeded tenant has
      // been the target of hundreds of other tests' users by the time this
      // runs, and getAllUsers carries no ORDER BY, so "is it anywhere in the
      // first 200 rows" is a coin flip against however large that table has
      // grown -- exactly the kind of flake a size-independent assertion
      // avoids rather than papers over with a bigger limit.
      const decoyAsAdmin = await adminAgent
        .get(`/api/users?role=admin&search=decoy-${stamp}`)
        .expect(200);
      expect(decoyAsAdmin.body.users.map((row) => row.id)).not.toContain(
        decoy.id
      );

      // "user" is this app's word for "not an admin here", and that is what
      // this account actually holds -- a customer membership, nothing more.
      const decoyAsUser = await adminAgent
        .get(`/api/users?role=user&search=decoy-${stamp}`)
        .expect(200);
      expect(decoyAsUser.body.users.map((row) => row.id)).toContain(decoy.id);

      const testAdminAsAdmin = await adminAgent
        .get(`/api/users?role=admin&search=${testAdmin.email}`)
        .expect(200);
      expect(testAdminAsAdmin.body.users.map((row) => row.id)).toContain(
        testAdmin.id
      );

      const testAdminAsUser = await adminAgent
        .get(`/api/users?role=user&search=${testAdmin.email}`)
        .expect(200);
      expect(testAdminAsUser.body.users.map((row) => row.id)).not.toContain(
        testAdmin.id
      );
    } finally {
      await db
        .delete(memberships)
        .where(
          and(
            eq(memberships.user_id, decoy.id),
            inArray(memberships.tenant_id, [SEED_TENANT_ID])
          )
        );
      await db.delete(user).where(eq(user.id, decoy.id));
    }
  });

  it('keeps another operator’s people out of the user list and lookup', async () => {
    // A user row with no membership at this operator stands in for somebody
    // who works only for another one -- the `user` table is global, so the
    // only thing that ever distinguished them was the join.
    const [outsider] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `outsider-list-${Date.now()}@example.com`,
        name: 'Another Operator Staff',
        role: 'user',
      })
      .returning();

    try {
      const list = await adminAgent.get('/api/users?limit=200').expect(200);
      const ids = list.body.users.map((row) => row.id);

      // Not merely absent from this page -- absent because the join has
      // nothing to join to. Absence holds regardless of how large this list
      // is, unlike a presence check against an unordered, capped page.
      expect(ids).not.toContain(outsider.id);

      // Scoped by email rather than trusting testAdmin to land within the
      // first 200 rows of a table with no ORDER BY -- this tenant has been
      // the target of a great many other tests' users by now, and "is this
      // one somewhere on an arbitrary page" is exactly the flake a narrow
      // search avoids.
      const mine = await adminAgent
        .get(`/api/users?search=${testAdmin.email}`)
        .expect(200);
      expect(mine.body.users.map((row) => row.id)).toContain(testAdmin.id);

      // And not reachable by id either. Same body as an id that exists
      // nowhere, so the two cannot be told apart.
      const direct = await adminAgent
        .get(`/api/users/${outsider.id}`)
        .expect(404);
      expect(direct.body.error).toBe('User not found');
    } finally {
      await db.delete(user).where(eq(user.id, outsider.id));
    }
  });

  it('counts only this operator’s people in the stats', async () => {
    const before = await adminAgent.get('/api/users/stats').expect(200);

    const [outsider] = await db
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        email: `outsider-stats-${Date.now()}@example.com`,
        name: 'Not Counted',
        role: 'admin',
      })
      .returning();

    try {
      const after = await adminAgent.get('/api/users/stats').expect(200);

      // role: 'admin' on the global row and no membership here. The old
      // implementation tallied that column across the whole deployment, so
      // this would have moved both numbers.
      expect(after.body.data.total).toBe(before.body.data.total);
      expect(after.body.data.admins).toBe(before.body.data.admins);
    } finally {
      await db.delete(user).where(eq(user.id, outsider.id));
    }
  });

  it('refuses to grant a role to an id that names nobody', async () => {
    const response = await adminAgent
      .post('/api/memberships')
      .send({ user_id: 'no-such-user-id', role: 'staff' })
      .expect(400);

    expect(response.body.error).toBe('Unknown user');
  });

  it('is closed to a customer', async () => {
    const { agent } = await createAuthenticatedAgent(app, redis);

    await agent.get('/api/memberships').expect(403);
    await agent
      .post('/api/memberships')
      .send({ user_id: testAdmin.id, role: 'admin' })
      .expect(403);
  });
});
