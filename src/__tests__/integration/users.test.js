// ============================================
// FILE: src/__tests__/integration/users.test.js
// ============================================
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { user } from '#models/user.model.js';
import { blogPosts } from '#models/blog.model.js';
import {
  createMockUser,
  deleteTestUser,
  deleteTestAdmin,
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
} from '../helpers/auth.helper.js';

describe('User/Admin CRUD Tests', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    if (redis && redis.status === 'ready') {
      await redis.quit();
    }
  });

  // ========================================
  // TEST SUITE 1: GET /api/users - Get All Users (Admin Only)
  // ========================================
  describe('GET /api/users - Get All Users', () => {
    let adminAgent;
    let userAgent;
    let testAdmin;
    let testUser;
    let adminSessionId;
    let userSessionId;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;

      // Create regular user
      const userAuth = await createAuthenticatedAgent(app, redis);
      userAgent = userAuth.agent;
      testUser = userAuth.user;
      userSessionId = userAuth.sessionId;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
      await deleteTestUser(testUser.id);
      await redis.del(`sess:${adminSessionId}`);
      await redis.del(`sess:${userSessionId}`);
    });

    it('should allow admin to get all users', async () => {
      const response = await adminAgent.get('/api/users').expect(200);

      expect(response.body).toHaveProperty('users');
      expect(response.body).toHaveProperty('message');
      expect(Array.isArray(response.body.users)).toBe(true);
      expect(response.body.users.length).toBeGreaterThan(0);
      expect(response.body.message).toBe('Successfully retrieved users');
    });

    it('should block regular user from getting all users', async () => {
      const response = await userAgent.get('/api/users').expect(403);

      expect(response.body.error).toBe('Access denied');
      expect(response.body.message).toBe('Insufficient permissions');
    });

    it('should block unauthenticated user', async () => {
      await request(app).get('/api/users').expect(401);
    });

    it('should support search filter', async () => {
      const response = await adminAgent
        .get('/api/users?search=test')
        .expect(200);

      expect(response.body.users).toBeDefined();
      expect(response.body.filters.search).toBe('test');
    });

    it('should support role filter', async () => {
      const response = await adminAgent
        .get('/api/users?role=admin')
        .expect(200);

      expect(response.body.users).toBeDefined();
      expect(response.body.filters.role).toBe('admin');
    });

    it('should support pagination', async () => {
      const response = await adminAgent
        .get('/api/users?limit=10&offset=0')
        .expect(200);

      expect(response.body.filters.limit).toBe(10);
      expect(response.body.filters.offset).toBe(0);
    });
  });

  // ========================================
  // TEST SUITE 2: GET /api/users/stats - Get User Stats (Admin Only)
  // ========================================
  describe('GET /api/users/stats - Get User Statistics', () => {
    let adminAgent;
    let userAgent;
    let testAdmin;
    let testUser;
    let adminSessionId;
    let userSessionId;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;

      const userAuth = await createAuthenticatedAgent(app, redis);
      userAgent = userAuth.agent;
      testUser = userAuth.user;
      userSessionId = userAuth.sessionId;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
      await deleteTestUser(testUser.id);
      await redis.del(`sess:${adminSessionId}`);
      await redis.del(`sess:${userSessionId}`);
    });

    it('should allow admin to get user statistics', async () => {
      const response = await adminAgent.get('/api/users/stats').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('total');
      expect(response.body.data).toHaveProperty('admins');
      expect(response.body.data).toHaveProperty('regular');
      expect(typeof response.body.data.total).toBe('number');
    });

    it('should block regular user from getting stats', async () => {
      const response = await userAgent.get('/api/users/stats').expect(403);

      expect(response.body.error).toBe('Access denied');
    });

    it('should block unauthenticated user', async () => {
      await request(app).get('/api/users/stats').expect(401);
    });
  });

  // ========================================
  // TEST SUITE 3: GET /api/users/:id - Get User by ID
  // ========================================
  describe('GET /api/users/:id - Get User by ID', () => {
    let agent;
    let testUser;
    let sessionId;

    beforeEach(async () => {
      const auth = await createAuthenticatedAgent(app, redis);
      agent = auth.agent;
      testUser = auth.user;
      sessionId = auth.sessionId;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
      await redis.del(`sess:${sessionId}`);
    });

    it('should get user by valid ID', async () => {
      const response = await agent.get(`/api/users/${testUser.id}`).expect(200);

      expect(response.body).toHaveProperty('user');
      expect(response.body.user.id).toBe(testUser.id);
      expect(response.body.user.email).toBe(testUser.email);
      expect(response.body.message).toBe('User retrieved successfully');
    });

    it('should return 404 for invalid/non-existent user ID', async () => {
      const response = await agent.get('/api/users/invalid-id').expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should block unauthenticated user', async () => {
      await request(app).get(`/api/users/${testUser.id}`).expect(401);
    });
  });

  // ========================================
  // TEST SUITE 4: PUT /api/users/:id - Update User
  // ========================================
  describe('PUT /api/users/:id - Update User', () => {
    let userAgent;
    let adminAgent;
    let testUser;
    let testAdmin;
    let userSessionId;
    let adminSessionId;

    beforeEach(async () => {
      const userAuth = await createAuthenticatedAgent(app, redis);
      userAgent = userAuth.agent;
      testUser = userAuth.user;
      userSessionId = userAuth.sessionId;

      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;
    });

    afterEach(async () => {
      await deleteTestUser(testUser.id);
      await deleteTestAdmin(testAdmin.id);
      await redis.del(`sess:${userSessionId}`);
      await redis.del(`sess:${adminSessionId}`);
    });

    it('should allow user to update their own name', async () => {
      const updates = { name: 'Updated Name' };

      const response = await userAgent
        .put(`/api/users/${testUser.id}`)
        .send(updates)
        .expect(200);

      expect(response.body.user.name).toBe('Updated Name');
      expect(response.body.message).toBe('User updated successfully');
    });

    it('should allow user to update their own email', async () => {
      const newEmail = `updated-${Date.now()}@example.com`;
      const updates = { email: newEmail };

      const response = await userAgent
        .put(`/api/users/${testUser.id}`)
        .send(updates)
        .expect(200);

      expect(response.body.user.email).toBe(newEmail);
    });

    it('should prevent user from updating another user', async () => {
      const otherUser = await createMockUser();

      const response = await userAgent
        .put(`/api/users/${otherUser.id}`)
        .send({ name: 'Hacker' })
        .expect(403);

      expect(response.body.error).toBe('Access denied');

      // Cleanup
      await deleteTestUser(otherUser.id);
    });

    it('should prevent regular user from changing their role', async () => {
      const response = await userAgent
        .put(`/api/users/${testUser.id}`)
        .send({ role: 'admin' })
        .expect(403);

      expect(response.body.error).toBe('Access denied');
      expect(response.body.message).toContain('administrators');
    });

    it('should allow admin to change user role', async () => {
      const response = await adminAgent
        .put(`/api/users/${testUser.id}`)
        .send({ role: 'admin' })
        .expect(200);

      expect(response.body.user.role).toBe('admin');
    });

    it('should return 409 for duplicate email', async () => {
      const existingUser = await createMockUser();

      const response = await userAgent
        .put(`/api/users/${testUser.id}`)
        .send({ email: existingUser.email })
        .expect(409);

      expect(response.body.error).toBe('Email already exists');

      // Cleanup
      await deleteTestUser(existingUser.id);
    });

    it('should return 400 for empty update', async () => {
      const response = await userAgent
        .put(`/api/users/${testUser.id}`)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 404 for non-existent user ID on update', async () => {
      const response = await adminAgent
        .put('/api/users/invalid')
        .send({ name: 'Test' })
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });
  });

  // ========================================
  // TEST SUITE 5: DELETE /api/users/:id - Delete User (Admin Only)
  // ========================================
  describe('DELETE /api/users/:id - Delete User', () => {
    let adminAgent;
    let userAgent;
    let testAdmin;
    let testUser;
    let adminSessionId;
    let userSessionId;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;

      const userAuth = await createAuthenticatedAgent(app, redis);
      userAgent = userAuth.agent;
      testUser = userAuth.user;
      userSessionId = userAuth.sessionId;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
      await deleteTestUser(testUser.id);
      await redis.del(`sess:${adminSessionId}`);
      await redis.del(`sess:${userSessionId}`);
    });

    it('should allow admin to delete a user', async () => {
      const userToDelete = await createMockUser();

      const response = await adminAgent
        .delete(`/api/users/${userToDelete.id}`)
        .expect(200);

      expect(response.body.message).toBe('User deleted successfully');
      expect(response.body.user.id).toBe(userToDelete.id);

      // Verify user is deleted
      const [deletedUser] = await db
        .select()
        .from(user)
        .where(eq(user.id, userToDelete.id));

      expect(deletedUser).toBeUndefined();
    });

    it('should prevent admin from deleting themselves', async () => {
      const response = await adminAgent
        .delete(`/api/users/${testAdmin.id}`)
        .expect(403);

      expect(response.body.error).toBe('Operation denied');
      expect(response.body.message).toContain(
        'cannot delete their own account'
      );
    });

    it('should block regular user from deleting users', async () => {
      const userToDelete = await createMockUser();

      const response = await userAgent
        .delete(`/api/users/${userToDelete.id}`)
        .expect(403);

      expect(response.body.error).toBe('Access denied');

      // Cleanup
      await deleteTestUser(userToDelete.id);
    });

    it('should return 404 for non-existent user ID on delete', async () => {
      const response = await adminAgent
        .delete('/api/users/invalid')
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should block unauthenticated user', async () => {
      await request(app).delete(`/api/users/${testUser.id}`).expect(401);
    });

    it('should allow deleting a user who has authored blog posts, nulling out author_id', async () => {
      const userToDelete = await createMockUser();

      const [post] = await db
        .insert(blogPosts)
        .values({
          title: 'Test Post',
          slug: `test-post-${Date.now()}`,
          excerpt: 'A short excerpt for the test post.',
          content: 'Test content',
          author_id: userToDelete.id,
          status: 'published',
        })
        .returning();

      await adminAgent.delete(`/api/users/${userToDelete.id}`).expect(200);

      const [updatedPost] = await db
        .select()
        .from(blogPosts)
        .where(eq(blogPosts.id, post.id));

      expect(updatedPost.author_id).toBeNull();

      // cleanup
      await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
    });
  });

  // ========================================
  // TEST SUITE 6: Edge Cases & Validation
  // ========================================
  describe('Edge Cases & Validation', () => {
    let adminAgent;
    let testAdmin;
    let adminSessionId;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
      await redis.del(`sess:${adminSessionId}`);
    });

    it('should return 404 for non-existent user ID on get', async () => {
      const response = await adminAgent
        .get('/api/users/not-a-number')
        .expect(404);
      expect(response.body.error).toBe('User not found');
    });

    it('should return 404 for non-existent user ID on update', async () => {
      const response = await adminAgent
        .put('/api/users/invalid')
        .send({ name: 'Test' })
        .expect(404);
      expect(response.body.error).toBe('User not found');
    });

    it('should return 404 for non-existent user ID on delete', async () => {
      const response = await adminAgent
        .delete('/api/users/invalid')
        .expect(404);
      expect(response.body.error).toBe('User not found');
    });

    it('should validate email format on update', async () => {
      const response = await adminAgent
        .put(`/api/users/${testAdmin.id}`)
        .send({ email: 'not-an-email' })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    });

    it('should validate name length on update', async () => {
      const response = await adminAgent
        .put(`/api/users/${testAdmin.id}`)
        .send({ name: 'x' }) // Too short
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    });

    it('should validate role enum on update', async () => {
      const response = await adminAgent
        .put(`/api/users/${testAdmin.id}`)
        .send({ role: 'superadmin' }) // Invalid role
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    });
  });

  // ========================================
  // TEST SUITE 7: Concurrent Operations
  // ========================================
  describe('Concurrent Operations', () => {
    let adminAgent;
    let testAdmin;
    let adminSessionId;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
      await redis.del(`sess:${adminSessionId}`);
    });

    it('should handle concurrent user updates', async () => {
      const testUser = await createMockUser();

      const updates = [
        adminAgent.put(`/api/users/${testUser.id}`).send({ name: 'Name1' }),
        adminAgent.put(`/api/users/${testUser.id}`).send({ name: 'Name2' }),
        adminAgent.put(`/api/users/${testUser.id}`).send({ name: 'Name3' }),
      ];

      const responses = await Promise.all(updates);

      // ✅ At least one should succeed
      const hasSuccess = responses.some((r) => r.status === 200);
      expect(hasSuccess).toBe(true);

      // ✅ All responses should be either success or expected error
      responses.forEach((response) => {
        expect([200, 409, 500]).toContain(response.status);
      });

      // Cleanup
      await deleteTestUser(testUser.id);
    });

    it('should handle concurrent user retrievals', async () => {
      const promises = [
        adminAgent.get(`/api/users/${testAdmin.id}`),
        adminAgent.get(`/api/users/${testAdmin.id}`),
        adminAgent.get(`/api/users/${testAdmin.id}`),
      ];

      const responses = await Promise.all(promises);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.user.id).toBe(testAdmin.id);
      });
    });
  });
});
