import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq, and } from 'drizzle-orm';

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
      // nothing to join to.
      expect(ids).not.toContain(outsider.id);
      expect(ids).toContain(testAdmin.id);

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
