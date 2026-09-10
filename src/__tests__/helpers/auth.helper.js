// ============================================
// FILE: src/__tests__/helpers/auth.helper.js
// ============================================

import request from 'supertest';
import crypto from 'crypto';
import { db } from '#config/database.js';
import { user } from '#models/user.model.js';
import { memberships } from '#models/membership.model.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import { eq } from 'drizzle-orm';

const TEST_PASSWORD = 'TestPassword123!';

/**
 * Create a real user via Better Auth's sign-up endpoint, using a fresh
 * supertest agent so the session cookie is captured automatically.
 * Returns { agent, user, email } — the agent is already authenticated.
 */
export const createAuthenticatedAgent = async (app, redis, opts = {}) => {
  const agent = request.agent(app);
  const timestamp = Date.now();
  const email = opts.email || `test-${timestamp}@example.com`;
  const name = opts.name || 'Test User';

  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: TEST_PASSWORD, name });

  if (!response.body?.user) {
    throw new Error(
      `Sign-up failed in test helper: ${JSON.stringify(response.body)}`
    );
  }

  const newUser = response.body.user;

  return { agent, user: newUser, sessionId: newUser.id, email };
};

/**
 * Create an authenticated ADMIN agent.
 *
 * Authority comes from an admin MEMBERSHIP at the tenant the request resolves
 * to, not from user.role -- that column is one global string and granting it
 * would have made the holder an admin at every operator, which is the bug the
 * memberships table exists to fix.
 *
 * user.role is still set to 'admin' because the users admin screen filters and
 * reports on it, and tests assert those counts. It confers nothing.
 */
export const createAuthenticatedAdminAgent = async (app) => {
  const agent = request.agent(app);
  const timestamp = Date.now();
  const email = `admin-${timestamp}@example.com`;
  const name = 'Test Admin';

  await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: TEST_PASSWORD, name });

  const [admin] = await db
    .update(user)
    .set({ role: 'admin' })
    .where(eq(user.email, email))
    .returning();

  // The grant that actually matters. Seeded tenant, because that is what
  // resolveTenant returns with TENANT_HOST_SUFFIX unset -- which is every
  // deployment and every test today.
  await db
    .insert(memberships)
    .values({
      tenant_id: SEED_TENANT_ID,
      user_id: admin.id,
      role: 'admin',
    })
    .onConflictDoNothing();

  // Re-sign-in so the session reflects the updated role
  await agent
    .post('/api/auth/sign-in/email')
    .send({ email, password: TEST_PASSWORD });

  return { agent, user: admin, sessionId: admin.id, email };
};

/**
 * Create a plain user row in the DB without signing up through Better Auth.
 * Use this when a test just needs a user to exist (e.g. as a target for
 * "access another user's data" checks) — not when the test needs to act
 * as that user, which requires createAuthenticatedAgent instead.
 */
export const createMockUser = async () => {
  const timestamp = Date.now();
  const [newUser] = await db
    .insert(user)
    .values({
      id: crypto.randomUUID(),
      email: `test-${timestamp}@example.com`,
      name: 'Test User',
      role: 'user',
    })
    .returning();

  return newUser;
};

/**
 * Clean up a test user (and cascade-deletes their sessions/accounts
 * via the FK onDelete: 'cascade' defined in user.model.js)
 */
export const deleteTestUser = async (userId) => {
  if (!userId) return;
  await db.delete(user).where(eq(user.id, userId));
};

export const deleteTestAdmin = async (adminId) => {
  if (!adminId) return;
  await db.delete(user).where(eq(user.id, adminId));
};

/**
 * No-op kept for backward compatibility with existing test files that
 * still call cleanupTestSession — session rows are removed automatically
 * via cascade delete when the user is deleted.
 */
export const cleanupTestSession = async () => {
  // intentionally empty — cascade delete handles this now
};
