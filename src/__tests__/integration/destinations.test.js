// src/__tests__/integration/destinations.test.js
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { destinations } from '#models/destination.model.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  deleteTestAdmin,
  cleanupTestSession,
} from '../helpers/auth.helper.js';

describe('Destination API Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;
  let testDestination;

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    // Create regular user agent
    const userAuth = await createAuthenticatedAgent(app, redis);
    agent = userAuth.agent;
    testUser = userAuth.user;
    sessionId = userAuth.sessionId;

    // Create admin agent
    const adminAuth = await createAuthenticatedAdminAgent(app);
    adminAgent = adminAuth.agent;
    testAdmin = adminAuth.user;
    adminSessionId = adminAuth.sessionId;

    // Create test destination
    testDestination = await createTestDestination();
  });

  afterEach(async () => {
    // Clean up
    if (testDestination) {
      await db
        .delete(destinations)
        .where(eq(destinations.id, testDestination.id));
    }
    await deleteTestUser(testUser.id);
    await deleteTestUser(testAdmin.id);
    await cleanupTestSession(redis, sessionId);
    await cleanupTestSession(redis, adminSessionId);
  });

  afterAll(async () => {
    await redis.quit();
  });

  // ========================================
  // TEST 1: Get All Destinations (Public)
  // ========================================
  describe('GET /api/destinations - Get All Destinations', () => {
    it('should return all destinations without authentication', async () => {
      const response = await request(app).get('/api/destinations').expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should filter destinations by featured', async () => {
      const response = await request(app)
        .get('/api/destinations?featured=true')
        .expect(200);

      expect(response.body.success).toBe(true);
      response.body.data.forEach((dest) => {
        expect(dest.featured).toBe(true);
      });
    });

    it('should filter destinations by country', async () => {
      const response = await request(app)
        .get('/api/destinations?country=Kenya')
        .expect(200);

      expect(response.body.success).toBe(true);
      if (response.body.data.length > 0) {
        response.body.data.forEach((dest) => {
          expect(dest.country).toBe('Kenya');
        });
      }
    });

    it('should search destinations by title', async () => {
      const response = await request(app)
        .get(
          `/api/destinations?search=${testDestination.title.substring(0, 5)}`
        )
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should paginate results', async () => {
      const response = await request(app)
        .get('/api/destinations?page=1&limit=5')
        .expect(200);

      expect(response.body.success).toBe(true);
      //expect(response.body.page).toBe('1');
      //expect(response.body.limit).toBe('5');
      expect(response.body.page).toBe(1); // Change to number
      expect(response.body.limit).toBe(5); // Change to number
    });
  });

  // ========================================
  // TEST 2: Get Destination by ID (Public)
  // ========================================
  describe('GET /api/destinations/:id - Get Destination by ID', () => {
    it('should return destination details for valid ID', async () => {
      const response = await request(app)
        .get(`/api/destinations/${testDestination.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testDestination.id);
      expect(response.body.data.title).toBe(testDestination.title);
    });

    it('should return 404 for non-existent destination', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const response = await request(app)
        .get(`/api/destinations/${fakeId}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Destination not found');
    });
  });

  // ========================================
  // TEST 3: Get Destination by Slug (Public)
  // ========================================
  describe('GET /api/destinations/slug/:slug - Get by Slug', () => {
    it('should return destination by slug', async () => {
      const response = await request(app)
        .get(`/api/destinations/slug/${testDestination.slug}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.slug).toBe(testDestination.slug);
      expect(response.body.data.id).toBe(testDestination.id);
    });

    it('should return 404 for non-existent slug', async () => {
      const response = await request(app)
        .get('/api/destinations/slug/non-existent-destination')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Destination not found');
    });
  });

  // ========================================
  // TEST 4: Create Destination (Admin Only)
  // ========================================
  describe('POST /api/destinations - Create Destination', () => {
    it('should create destination with valid admin credentials', async () => {
      const destinationData = {
        title: `Test Destination ${Date.now()}`,
        slug: `test-destination-${Date.now()}`,
        description:
          'A beautiful test destination with amazing wildlife and stunning landscapes.',
        image: 'https://example.com/test-destination.jpg',
        country: 'Kenya',
        region: 'Rift Valley',
        featured: true,
        position: 1,
      };

      const response = await adminAgent
        .post('/api/destinations')
        .send(destinationData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.title).toBe(destinationData.title);
      expect(response.body.message).toBe('Destination created successfully');

      // Clean up
      await db
        .delete(destinations)
        .where(eq(destinations.id, response.body.data.id));
    });

    it('should fail without authentication', async () => {
      const destinationData = {
        title: 'Test Destination',
        slug: 'test-destination',
        description:
          'Test description that is long enough to pass validation requirements.',
        image: 'https://example.com/test.jpg',
        country: 'Kenya',
      };

      await request(app)
        .post('/api/destinations')
        .send(destinationData)
        .expect(401);
    });

    // it('should fail with non-admin user', async () => {
    //   const destinationData = {
    //     title: 'Test Destination',
    //     slug: 'test-destination',
    //     description:
    //       'Test description that is long enough to pass validation requirements.',
    //     image: 'https://example.com/test.jpg',
    //     country: 'Kenya',
    //   };

    //   const response = await agent
    //     .post('/api/destinations')
    //     .send(destinationData)
    //     .expect(403);

    //   expect(response.body.success).toBe(false);
    // });

    it('should fail with non-admin user', async () => {
      const destinationData = {
        title: 'Test Destination',
        slug: 'test-destination',
        description:
          'Test description that is long enough to pass validation requirements.',
        image: 'https://example.com/test.jpg',
        country: 'Kenya',
      };

      const response = await agent
        .post('/api/destinations')
        .send(destinationData)
        .expect(403);

      expect(response.body.error).toBe('Access denied');
    });

    it('should fail with invalid data', async () => {
      const invalidData = {
        title: 'Te', // Too short
        slug: 'test',
        description: 'Too short', // Too short
        country: 'Kenya',
      };

      const response = await adminAgent
        .post('/api/destinations')
        .send(invalidData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation error');
    });

    it('should fail with duplicate slug', async () => {
      const destinationData = {
        title: 'Another Destination',
        slug: testDestination.slug, // Duplicate slug
        description:
          'Test description that is long enough to pass validation requirements.',
        image: 'https://example.com/test.jpg',
        country: 'Kenya',
      };

      const response = await adminAgent
        .post('/api/destinations')
        .send(destinationData)
        .expect(500);

      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // TEST 5: Update Destination (Admin Only)
  // ========================================
  describe('PATCH /api/destinations/:id - Update Destination', () => {
    it('should update destination with valid admin credentials', async () => {
      const updateData = {
        title: 'Updated Destination Title',
        description:
          'Updated description with more than fifty characters to pass validation.',
      };

      const response = await adminAgent
        .patch(`/api/destinations/${testDestination.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe(updateData.title);
      expect(response.body.data.description).toBe(updateData.description);
      expect(response.body.message).toBe('Destination updated successfully');
    });

    it('should fail without authentication', async () => {
      const updateData = { title: 'Updated Title' };

      await request(app)
        .patch(`/api/destinations/${testDestination.id}`)
        .send(updateData)
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      const updateData = { title: 'Updated Title' };

      await agent
        .patch(`/api/destinations/${testDestination.id}`)
        .send(updateData)
        .expect(403);
    });

    it('should return 404 for non-existent destination', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const updateData = { title: 'Updated Title' };

      const response = await adminAgent
        .patch(`/api/destinations/${fakeId}`)
        .send(updateData)
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // TEST 6: Delete Destination (Admin Only)
  // ========================================
  describe('DELETE /api/destinations/:id - Delete Destination', () => {
    it('should delete destination with valid admin credentials', async () => {
      // Create a destination to delete
      const [tempDest] = await db
        .insert(destinations)
        .values({
          title: 'Temp Destination',
          slug: `temp-dest-${Date.now()}`,
          description:
            'Temporary destination for deletion test with enough characters.',
          image: 'https://example.com/temp.jpg',
          country: 'Kenya',
        })
        .returning();

      const response = await adminAgent
        .delete(`/api/destinations/${tempDest.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Destination deleted successfully');

      // Verify deletion
      const [deleted] = await db
        .select()
        .from(destinations)
        .where(eq(destinations.id, tempDest.id));

      expect(deleted).toBeUndefined();
    });

    it('should fail without authentication', async () => {
      await request(app)
        .delete(`/api/destinations/${testDestination.id}`)
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.delete(`/api/destinations/${testDestination.id}`).expect(403);
    });

    it('should return 404 for non-existent destination', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      await adminAgent.delete(`/api/destinations/${fakeId}`).expect(404);
    });
  });

  // ========================================
  // TEST 7: Get Destination with Tours
  // ========================================
  describe('GET /api/destinations/:id/tours - Get with Tours', () => {
    it('should return destination with associated tours', async () => {
      const response = await request(app)
        .get(`/api/destinations/${testDestination.id}/tours`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testDestination.id);
      expect(Array.isArray(response.body.data.tours)).toBe(true);
    });
  });

  // ========================================
  // TEST 8: Get Destination Stats (Admin Only)
  // ========================================
  describe('GET /api/destinations/:id/stats - Get Stats', () => {
    it('should return destination statistics for admin', async () => {
      const response = await adminAgent
        .get(`/api/destinations/${testDestination.id}/stats`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('destination_id');
      expect(response.body.data).toHaveProperty('total_tours');
      expect(response.body.data).toHaveProperty('published_tours');
      expect(response.body.data).toHaveProperty('draft_tours');
    });

    it('should fail without authentication', async () => {
      await request(app)
        .get(`/api/destinations/${testDestination.id}/stats`)
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent
        .get(`/api/destinations/${testDestination.id}/stats`)
        .expect(403);
    });
  });

  describe('GET /api/destinations/stats/revenue-breakdown - Get Revenue Breakdown', () => {
    let adminAgent;
    let testAdmin;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
    });

    it('should return revenue breakdown without crashing', async () => {
      const response = await adminAgent
        .get('/api/destinations/stats/revenue-breakdown')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data.destinations)).toBe(true);
      expect(response.body.data).toHaveProperty('total_revenue');
      expect(response.body.data).toHaveProperty('top_destination');
    });

    it('should fail without authentication', async () => {
      await request(app)
        .get('/api/destinations/stats/revenue-breakdown')
        .expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.get('/api/destinations/stats/revenue-breakdown').expect(403);
    });
  });
});

// ========================================
// HELPER FUNCTIONS
// ========================================
async function createTestDestination() {
  const [destination] = await db
    .insert(destinations)
    .values({
      title: `Test Destination ${Date.now()}`,
      slug: `test-destination-${Date.now()}`,
      description:
        'A beautiful test destination with amazing wildlife, stunning landscapes, and unforgettable experiences.',
      image: 'https://example.com/test-destination.jpg',
      country: 'Kenya',
      region: 'Rift Valley',
      featured: true,
      position: 0,
    })
    .returning();

  return destination;
}
