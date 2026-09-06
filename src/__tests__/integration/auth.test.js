// ============================================
// FILE: src/__tests__/integration/auth.test.js
// ============================================
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { user, session } from '#models/user.model.js';
import {
  createMockUser,
  deleteTestUser,
  deleteTestAdmin,
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
} from '../helpers/auth.helper.js';

describe('Authentication & Authorization Tests', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await redis.quit();
  });

  // ========================================
  // TEST SUITE 1: requireAuth Middleware
  // ========================================
  describe('requireAuth Middleware', () => {
    let testUser;
    let agent;

    beforeEach(async () => {
      const auth = await createAuthenticatedAgent(app, redis);
      agent = auth.agent;
      testUser = auth.user;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
    });

    it('should allow authenticated user to access protected route', async () => {
      const response = await agent.get('/api/auth/me').expect(200);

      expect(response.body).toHaveProperty('user');
      expect(response.body.user.id).toBe(testUser.id);
      expect(response.body.user.email).toBe(testUser.email);
    });

    it('should block unauthenticated user from protected route', async () => {
      const response = await request(app).get('/api/auth/me').expect(401);

      expect(response.body.error).toBe('Authentication required');
      expect(response.body.message).toBe('No active session');
    });

    it('should block user with an invalid session token', async () => {
      const invalidAgent = request.agent(app);
      invalidAgent.set('Cookie', [
        'better-auth.session_token=invalid-token-value',
      ]);

      const response = await invalidAgent.get('/api/auth/me').expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    it('should block user with an expired session', async () => {
      // Force the real session row to be expired
      await db
        .update(session)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(session.userId, testUser.id));

      const response = await agent.get('/api/auth/me').expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    it('should attach user data to request object', async () => {
      const response = await agent.get('/api/auth/me').expect(200);

      expect(response.body.user).toMatchObject({
        id: testUser.id,
        email: testUser.email,
        role: testUser.role,
      });
    });
  });

  // ========================================
  // TEST SUITE 2: requireAdmin Middleware
  // ========================================
  describe('requireAdmin Middleware', () => {
    let regularUser;
    let adminUser;
    let userAgent;
    let adminAgent;

    beforeEach(async () => {
      const userAuth = await createAuthenticatedAgent(app, redis);
      userAgent = userAuth.agent;
      regularUser = userAuth.user;

      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      adminUser = adminAuth.user;
    });

    afterEach(async () => {
      await deleteTestUser(regularUser.id);
      await deleteTestAdmin(adminUser.id);
    });

    it('should allow admin to access admin-only route', async () => {
      const response = await adminAgent.get('/api/users').expect(200);

      expect(response.body).toHaveProperty('users');
      expect(Array.isArray(response.body.users)).toBe(true);
      expect(response.body.message).toBe('Successfully retrieved users');
    });

    it('should block regular user from admin-only route', async () => {
      const response = await userAgent.get('/api/users').expect(403);

      expect(response.body.error).toBe('Access denied');
      expect(response.body.message).toBe('Insufficient permissions');
    });

    it('should block unauthenticated user from admin-only route', async () => {
      const response = await request(app).get('/api/users').expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    it('should allow admin to delete users', async () => {
      const userToDelete = await createMockUser();

      const response = await adminAgent
        .delete(`/api/users/${userToDelete.id}`)
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('deleted');

      const [deletedUser] = await db
        .select()
        .from(user)
        .where(eq(user.id, userToDelete.id));

      expect(deletedUser).toBeUndefined();
    });

    it('should block regular user from deleting users', async () => {
      const targetUser = await createMockUser();

      const response = await userAgent
        .delete(`/api/users/${targetUser.id}`)
        .expect(403);

      expect(response.body.error).toBe('Access denied');

      const [existingUser] = await db
        .select()
        .from(user)
        .where(eq(user.id, targetUser.id));

      expect(existingUser).toBeDefined();

      await deleteTestUser(targetUser.id);
    });
  });

  // ========================================
  // TEST SUITE 3: requireRole Middleware
  // ========================================
  describe('requireRole Middleware', () => {
    let userAgent;
    let adminAgent;
    let testUser;
    let testAdmin;

    beforeEach(async () => {
      const userAuth = await createAuthenticatedAgent(app, redis);
      userAgent = userAuth.agent;
      testUser = userAuth.user;

      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
      await deleteTestAdmin(testAdmin.id);
    });

    it('should allow user with correct role to access route', async () => {
      const response = await adminAgent.get('/api/users/stats').expect(200);

      expect(response.body).toHaveProperty('success');
    });

    it('should block user without correct role', async () => {
      const response = await userAgent.get('/api/users/stats').expect(403);

      expect(response.body.error).toBe('Access denied');
      expect(response.body.message).toBe('Insufficient permissions');
    });

    it('should verify role is correctly attached to request', async () => {
      const userResponse = await userAgent.get('/api/auth/me').expect(200);
      expect(userResponse.body.user.role).toBe('user');

      const adminResponse = await adminAgent.get('/api/auth/me').expect(200);
      expect(adminResponse.body.user.role).toBe('admin');
    });
  });

  // ========================================
  // TEST SUITE 4: optionalAuth Middleware
  // ========================================
  describe('optionalAuth Middleware', () => {
    let testUser;
    let agent;

    beforeEach(async () => {
      const auth = await createAuthenticatedAgent(app, redis);
      agent = auth.agent;
      testUser = auth.user;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
    });

    it('should work for authenticated users', async () => {
      const response = await agent.get('/api/tours').expect(200);

      expect(response.body).toHaveProperty('success');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should work for unauthenticated users', async () => {
      const response = await request(app).get('/api/tours').expect(200);

      expect(response.body).toHaveProperty('success');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should not block requests without session', async () => {
      const response = await request(app).get('/api/tours').expect(200);

      expect(response.status).toBe(200);
    });
  });

  // ========================================
  // TEST SUITE 5: Logout Functionality
  //
  // NOTE: logout is handled entirely by Better Auth's own endpoint
  // (POST /api/auth/sign-out), not a custom route in authRoutes.
  // Confirm the exact path/response shape with:
  //   curl -X POST http://localhost:3000/api/auth/sign-out -v
  // and adjust the path/status below if it differs.
  // ========================================
  describe('POST /api/auth/sign-out', () => {
    let testUser;
    let agent;

    beforeEach(async () => {
      const auth = await createAuthenticatedAgent(app, redis);
      agent = auth.agent;
      testUser = auth.user;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
    });

    it('should successfully logout and destroy session', async () => {
      const beforeLogout = await agent.get('/api/auth/me').expect(200);
      expect(beforeLogout.body.user).toBeDefined();

      await agent.post('/api/auth/sign-out').expect(200);

      // Verify session row no longer validates
      await agent.get('/api/auth/me').expect(401);
    });

    it('should handle logout when not logged in', async () => {
      const response = await request(app).post('/api/auth/sign-out');

      // Better Auth's own behavior for sign-out without a session may
      // differ from your custom middleware's 401 shape — confirm via curl
      // and tighten this assertion once confirmed.
      expect([200, 401]).toContain(response.status);
    });
  });

  // ========================================
  // TEST SUITE 6: Session Persistence
  // ========================================
  describe('Session Persistence', () => {
    let testUser;
    let agent;

    beforeEach(async () => {
      const auth = await createAuthenticatedAgent(app, redis);
      agent = auth.agent;
      testUser = auth.user;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
    });

    it('should maintain session across multiple requests', async () => {
      await agent.get('/api/auth/me').expect(200);
      await agent.get('/api/auth/me').expect(200);

      const response = await agent.get('/api/auth/me').expect(200);
      expect(response.body.user.id).toBe(testUser.id);

      // Verify the real session row still exists in Postgres
      const rows = await db
        .select()
        .from(session)
        .where(eq(session.userId, testUser.id));

      expect(rows.length).toBeGreaterThan(0);
    });

    it('should preserve user data in session', async () => {
      const response1 = await agent.get('/api/auth/me').expect(200);
      const response2 = await agent.get('/api/auth/me').expect(200);

      expect(response1.body.user).toEqual(response2.body.user);
      expect(response1.body.user.email).toBe(testUser.email);
      expect(response1.body.user.role).toBe(testUser.role);
    });
  });

  // ========================================
  // TEST SUITE 7: Edge Cases
  // ========================================
  describe('Edge Cases & Security', () => {
    let testUser;

    beforeEach(async () => {
      const auth = await createAuthenticatedAgent(app, redis);
      testUser = auth.user;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
    });

    it('should reject malformed session cookies', async () => {
      const agent = request.agent(app);
      agent.set('Cookie', ['better-auth.session_token=malformed-value']);

      await agent.get('/api/auth/me').expect(401);
    });

    it('should reject an empty session token', async () => {
      const agent = request.agent(app);
      agent.set('Cookie', ['better-auth.session_token=']);

      await agent.get('/api/auth/me').expect(401);
    });

    it('should handle concurrent requests with the same session', async () => {
      const auth = await createAuthenticatedAgent(app, redis);

      const promises = [
        auth.agent.get('/api/auth/me'),
        auth.agent.get('/api/auth/me'),
        auth.agent.get('/api/auth/me'),
      ];

      const responses = await Promise.all(promises);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.user.id).toBe(auth.user.id);
      });

      await deleteTestUser(auth.user.id);
    });

    it("should allow a logged-in user to view another user's public profile", async () => {
      const authA = await createAuthenticatedAgent(app, redis);
      const authB = await createAuthenticatedAgent(app, redis);

      const response = await authA.agent.get(`/api/users/${authB.user.id}`);

      // GET /api/users/:id has no ownership restriction in this API —
      // any authenticated user can view another user's basic profile.
      // Only PUT/DELETE on /api/users/:id are owner-or-admin restricted.
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(authB.user.id);

      await deleteTestUser(authA.user.id);
      await deleteTestUser(authB.user.id);
    });
  });
});
