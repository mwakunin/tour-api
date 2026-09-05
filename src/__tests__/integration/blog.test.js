// src/__tests__/integration/blog.test.js

import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { blogPosts, blogCategories } from '#models/blog.model.js';
import { user } from '#models/user.model.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  createMockUser,
  deleteTestUser,
  deleteTestAdmin,
} from '../helpers/auth.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

describe('Blog API Integration Tests', () => {
  let agent;
  let testUser;
  let adminAgent;
  let testAdmin;
  let testCategory;

  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const userAuth = await createAuthenticatedAgent(app, redis);
    agent = userAuth.agent;
    testUser = userAuth.user;

    const adminAuth = await createAuthenticatedAdminAgent(app);
    adminAgent = adminAuth.agent;
    testAdmin = adminAuth.user;

    const [category] = await db
      .insert(blogCategories)
      .values({
        tenant_id: SEED_TENANT_ID,
        name: `Test Category ${Date.now()}`,
        slug: `test-category-${Date.now()}`,
        description: 'A test category',
      })
      .returning();
    testCategory = category;
  });

  afterEach(async () => {
    await deleteTestUser(testUser.id);
    await deleteTestAdmin(testAdmin.id);
    await db
      .delete(blogCategories)
      .where(eq(blogCategories.id, testCategory.id));
  });

  const validPostPayload = (overrides = {}) => ({
    title: 'A Complete Guide to Safari Adventures',
    excerpt:
      'This is a test excerpt that is definitely long enough to pass the fifty character minimum requirement.',
    content:
      'This is the full test content for the blog post, which needs to be at least one hundred characters long to satisfy the validation schema requirements for blog post content.',
    status: 'draft',
    ...overrides,
  });

  // ========================================
  // PUBLIC: GET /api/blog/posts
  // ========================================
  describe('GET /api/blog/posts - List Published Posts', () => {
    // "should return only published posts"
    it('should return only published posts', async () => {
      const [published] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Published Post',
          slug: `published-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'published',
          published_at: new Date(),
        })
        .returning();

      const [draft] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Draft Post',
          slug: `draft-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'draft',
        })
        .returning();

      const response = await request(app).get('/api/blog/posts').expect(200);

      expect(response.body.success).toBe(true);
      const slugs = response.body.data.map((p) => p.slug);
      expect(slugs).toContain(published.slug);
      expect(slugs).not.toContain(draft.slug);

      await db.delete(blogPosts).where(eq(blogPosts.id, published.id));
      await db.delete(blogPosts).where(eq(blogPosts.id, draft.id));
    });

    // "should support pagination"
    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/blog/posts?page=1&limit=5')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body).toHaveProperty('pagination');
    });

    it('should work without authentication', async () => {
      await request(app).get('/api/blog/posts').expect(200);
    });
  });

  // ========================================
  // PUBLIC: GET /api/blog/posts/:slug
  // ========================================
  describe('GET /api/blog/posts/:slug - Get Published Post by Slug', () => {
    it('should return a published post by slug', async () => {
      const [post] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Findable Post',
          slug: `findable-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'published',
          published_at: new Date(),
        })
        .returning();

      const response = await request(app)
        .get(`/api/blog/posts/${post.slug}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.slug).toBe(post.slug);

      await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
    });

    it('should return 404 for a draft post accessed via public route', async () => {
      const [draft] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Hidden Draft',
          slug: `hidden-draft-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'draft',
        })
        .returning();

      await request(app).get(`/api/blog/posts/${draft.slug}`).expect(404);

      await db.delete(blogPosts).where(eq(blogPosts.id, draft.id));
    });

    it('should return 404 for non-existent slug', async () => {
      await request(app).get('/api/blog/posts/does-not-exist-slug').expect(404);
    });
  });

  // ========================================
  // PUBLIC: GET /api/blog/categories
  // ========================================
  describe('GET /api/blog/categories - List Categories', () => {
    it('should return categories', async () => {
      await redis.del('blog:categories');

      const response = await request(app)
        .get('/api/blog/categories')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      const names = response.body.data.map((c) => c.id);
      expect(names).toContain(testCategory.id);
    });
  });

  // ========================================
  // ADMIN: GET /api/blog/admin/posts
  // ========================================
  describe('GET /api/blog/admin/posts - List All Posts (Admin)', () => {
    // admin "should include drafts for admin"
    it('should include drafts for admin', async () => {
      const [draft] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Admin Visible Draft',
          slug: `admin-draft-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'draft',
        })
        .returning();

      const response = await adminAgent
        .get('/api/blog/admin/posts')
        .expect(200);

      expect(response.body.success).toBe(true);
      const slugs = response.body.data.map((p) => p.slug);
      expect(slugs).toContain(draft.slug);

      await db.delete(blogPosts).where(eq(blogPosts.id, draft.id));
    });

    it('should fail without authentication', async () => {
      await request(app).get('/api/blog/admin/posts').expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.get('/api/blog/admin/posts').expect(403);
    });
  });

  // ========================================
  // ADMIN: POST /api/blog/admin/posts
  // ========================================
  describe('POST /api/blog/admin/posts - Create Post', () => {
    it('should create a post with valid data', async () => {
      const response = await adminAgent
        .post('/api/blog/admin/posts')
        .send(validPostPayload({ category_id: testCategory.id }))
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe(
        'A Complete Guide to Safari Adventures'
      );
      expect(response.body.data.slug).toBeDefined();

      await db.delete(blogPosts).where(eq(blogPosts.id, response.body.data.id));
    });

    it('should auto-generate a slug when not provided', async () => {
      const response = await adminAgent
        .post('/api/blog/admin/posts')
        .send(validPostPayload())
        .expect(201);

      expect(response.body.data.slug).toBeTruthy();
      expect(response.body.data.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

      await db.delete(blogPosts).where(eq(blogPosts.id, response.body.data.id));
    });

    it('should fail with excerpt too short', async () => {
      const response = await adminAgent
        .post('/api/blog/admin/posts')
        .send(validPostPayload({ excerpt: 'too short' }))
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should fail with content too short', async () => {
      const response = await adminAgent
        .post('/api/blog/admin/posts')
        .send(validPostPayload({ content: 'too short' }))
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should fail without authentication', async () => {
      await request(app)
        .post('/api/blog/admin/posts')
        .send(validPostPayload())
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent
        .post('/api/blog/admin/posts')
        .send(validPostPayload())
        .expect(403);
    });
  });

  // ========================================
  // ADMIN: PUT /api/blog/admin/posts/:id
  // ========================================
  describe('PUT /api/blog/admin/posts/:id - Update Post', () => {
    it('should update a post', async () => {
      const [post] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Original Title Goes Here',
          slug: `update-me-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'draft',
        })
        .returning();

      const response = await adminAgent
        .put(`/api/blog/admin/posts/${post.id}`)
        .send({ status: 'published' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('published');

      await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
    });

    it('should return 404 for non-existent post', async () => {
      await adminAgent
        .put('/api/blog/admin/posts/999999999')
        .send({ status: 'published' })
        .expect(404);
    });
  });

  // ========================================
  // ADMIN: DELETE /api/blog/admin/posts/:id
  // ========================================
  describe('DELETE /api/blog/admin/posts/:id - Delete Post', () => {
    it('should delete a post', async () => {
      const [post] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Post To Be Deleted Here',
          slug: `delete-me-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'draft',
        })
        .returning();

      await adminAgent.delete(`/api/blog/admin/posts/${post.id}`).expect(200);

      const [found] = await db
        .select()
        .from(blogPosts)
        .where(eq(blogPosts.id, post.id));

      expect(found).toBeUndefined();
    });

    it('should fail with non-admin user', async () => {
      const [post] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Protected Post Right Here',
          slug: `protected-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'draft',
        })
        .returning();

      await agent.delete(`/api/blog/admin/posts/${post.id}`).expect(403);

      await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
    });
  });

  // ========================================
  // Data Integrity: author deletion nulls author_id
  // ========================================
  describe('Data Integrity - Author Deletion', () => {
    it('should preserve the post and null author_id when the author is deleted', async () => {
      const author = await createMockUser();

      const [post] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Post With A Real Author',
          slug: `authored-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'published',
          author_id: author.id,
        })
        .returning();

      await db.delete(user).where(eq(user.id, author.id));

      const [survived] = await db
        .select()
        .from(blogPosts)
        .where(eq(blogPosts.id, post.id));

      expect(survived).toBeDefined();
      expect(survived.author_id).toBeNull();

      await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
    });
  });

  // ========================================
  // ADMIN: Category CRUD
  // ========================================
  describe('POST /api/blog/admin/categories - Create Category', () => {
    it('should create a category', async () => {
      const response = await adminAgent
        .post('/api/blog/admin/categories')
        .send({ name: `New Category ${Date.now()}` })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.slug).toBeTruthy();

      await db
        .delete(blogCategories)
        .where(eq(blogCategories.id, response.body.data.id));
    });

    it('should fail with a name that is too short', async () => {
      await adminAgent
        .post('/api/blog/admin/categories')
        .send({ name: 'x' })
        .expect(400);
    });

    it('should fail with non-admin user', async () => {
      await agent
        .post('/api/blog/admin/categories')
        .send({ name: `Blocked Category ${Date.now()}` })
        .expect(403);
    });
  });

  describe('PUT /api/blog/admin/categories/:id - Update Category', () => {
    it('should update a category', async () => {
      const response = await adminAgent
        .put(`/api/blog/admin/categories/${testCategory.id}`)
        .send({ description: 'Updated description' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.description).toBe('Updated description');
    });
  });

  describe('DELETE /api/blog/admin/categories/:id - Delete Category', () => {
    it('should prevent deleting a category that still has posts', async () => {
      const [category] = await db
        .insert(blogCategories)
        .values({
          tenant_id: SEED_TENANT_ID,
          name: `Category In Use ${Date.now()}`,
          slug: `category-in-use-${Date.now()}`,
        })
        .returning();

      const [post] = await db
        .insert(blogPosts)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Post In A Category Right Here',
          slug: `categorized-${Date.now()}`,
          excerpt: 'x'.repeat(60),
          content: 'x'.repeat(120),
          status: 'published',
          category_id: category.id,
        })
        .returning();

      const response = await adminAgent
        .delete(`/api/blog/admin/categories/${category.id}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Cannot delete category with');

      await db.delete(blogPosts).where(eq(blogPosts.id, post.id));
      await db.delete(blogCategories).where(eq(blogCategories.id, category.id));
    });

    it('should delete a category with no posts attached', async () => {
      const [category] = await db
        .insert(blogCategories)
        .values({
          tenant_id: SEED_TENANT_ID,
          name: `Empty Category ${Date.now()}`,
          slug: `empty-category-${Date.now()}`,
        })
        .returning();

      await adminAgent
        .delete(`/api/blog/admin/categories/${category.id}`)
        .expect(200);

      const [found] = await db
        .select()
        .from(blogCategories)
        .where(eq(blogCategories.id, category.id));

      expect(found).toBeUndefined();
    });
  });
});
