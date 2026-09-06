// ============================================
// FILE: src/__tests__/integration/tours.test.js
// ============================================
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { tours, tourDestinations } from '#models/tour.model.js';
import {
  deleteTestUser,
  deleteTestAdmin,
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
} from '../helpers/auth.helper.js';
import {
  createTestDestination,
  deleteTestDestination,
} from '../helpers/destination.helper.js';
import { buildTestPricingPeriod } from '../helpers/tour.helper.js';
import { cache } from '#utils/cache.js';
import { CacheKeys } from '#utils/cacheKeys.js';

describe('Tour CRUD Integration Tests', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    if (redis && redis.status === 'ready') {
      await redis.quit();
    }
  });

  // ========================================
  // TEST SUITE 1: POST /api/tours - Create Tour (Admin Only)
  // ========================================
  describe('POST /api/tours - Create Tour', () => {
    let adminAgent;
    let testAdmin;
    let adminSessionId;
    let testDestination;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;

      testDestination = await createTestDestination();
    });

    afterEach(async () => {
      // Clean up tours
      const allTours = await db.select().from(tours);
      for (const tour of allTours) {
        if (tour.slug?.startsWith('test-')) {
          await db.delete(tours).where(eq(tours.id, tour.id));
        }
      }

      await deleteTestDestination(testDestination.id);
      await deleteTestAdmin(testAdmin.id);
      await redis.del(`sess:${adminSessionId}`);
    });

    it('should create a tour with basic information', async () => {
      const tourData = {
        title: 'Test Safari Tour',
        slug: `test-safari-${Date.now()}`,
        overview:
          'A comprehensive test tour description that meets the minimum length requirement of 100 characters for the overview field.',
        duration: 3,
        duration_unit: 'days',
        pricing: {
          amount: 1200,
          currency: 'USD',
          discount_percentage: 0,
        },
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'published',
        categories: ['wildlife'],
        tags: ['safari', 'adventure'],
      };

      const response = await adminAgent
        .post('/api/tours')
        .send(tourData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.title).toBe(tourData.title);
      expect(response.body.message).toBe('Tour created successfully');
    });

    it('should create tour with seasonal pricing periods', async () => {
      const tourData = {
        title: 'Seasonal Pricing Tour',
        slug: `seasonal-tour-${Date.now()}`,
        overview:
          'A tour with multiple pricing periods based on season. This provides better rates in low season and flexibility for booking.',
        duration: 5,
        duration_unit: 'days',
        pricing_periods: [
          {
            label: 'Low Season',
            start_date: '2026-04-01',
            end_date: '2026-06-30',
            pricing_tiers: [
              // On offer: charged 600, was 800 -> 25% off
              {
                pax: 2,
                price_per_person: 600,
                compare_at_price: 800,
                currency: 'USD',
              },
              { pax: 4, price_per_person: 650, total: 2600, currency: 'USD' },
            ],
          },
          {
            label: 'Festive Season',
            start_date: '2026-12-23',
            end_date: '2027-01-02',
            pricing_tiers: [
              { pax: 2, price_per_person: 1100, total: 2200, currency: 'USD' },
            ],
          },
        ],
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'published',
      };

      const response = await adminAgent
        .post('/api/tours')
        .send(tourData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.pricing_periods).toHaveLength(2);
      expect(response.body.data.pricing_periods[0].label).toBe('Low Season');
      expect(response.body.data.pricing_periods[0].pricing_tiers).toHaveLength(
        2
      );
      // discount_percentage is DERIVED from the compare-at prices — none was sent
      expect(response.body.data.pricing.discount_percentage).toBe(25);
      expect(response.body.data.pricing_periods[0].pricing_tiers[0].price_per_person).toBe(600);
      // The festive period must survive the year boundary intact
      expect(response.body.data.pricing_periods[1].end_date).toBe('2027-01-02');
    });

    it('should create a flat-priced tour with no pricing periods', async () => {
      const tourData = {
        title: 'Airport Transfer',
        slug: `airport-transfer-${Date.now()}`,
        overview:
          'A simple airport transfer service with a single flat rate that does not vary by season or by the size of the travelling group.',
        duration: 2,
        duration_unit: 'hours',
        pricing: {
          amount: 50,
          currency: 'USD',
        },
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'published',
      };

      const response = await adminAgent
        .post('/api/tours')
        .send(tourData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.pricing_periods).toEqual([]);
      expect(response.body.data.pricing.amount).toBe(50);
    });

    it('should create a seasonal tour with no pricing object at all', async () => {
      // This is what the admin form sends for a seasonal tour: the flat
      // `pricing` key is omitted entirely, not sent as zero or null.
      const tourData = {
        title: 'Periods Only Tour',
        slug: `periods-only-${Date.now()}`,
        overview:
          'A tour priced purely by seasonal periods, with no flat base price supplied at all, exactly as the admin tour form submits it.',
        duration: 6,
        duration_unit: 'days',
        pricing_periods: [
          {
            label: 'Low Season',
            start_date: '2026-04-01',
            end_date: '2026-06-30',
            pricing_tiers: [
              { pax: 2, price_per_person: 800, total: 1600, currency: 'USD' },
            ],
          },
        ],
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'published',
      };

      const response = await adminAgent
        .post('/api/tours')
        .send(tourData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.pricing_periods).toHaveLength(1);
      // Flat columns stay null; currency still resolves from the tiers
      expect(response.body.data.pricing.amount).toBeNull();
      expect(response.body.data.pricing.currency).toBe('USD');
      expect(response.body.data.price_display).toContain('800');
    });

    it('should reject a tour with neither periods nor a base price', async () => {
      const tourData = {
        title: 'Unpriced Tour',
        slug: `unpriced-tour-${Date.now()}`,
        overview:
          'A tour submitted with no pricing periods and no flat base price, which cannot be booked and must be rejected at validation.',
        duration: 3,
        duration_unit: 'days',
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'published',
      };

      const response = await adminAgent.post('/api/tours').send(tourData);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    it('should reject overlapping pricing periods', async () => {
      const tourData = {
        title: 'Overlapping Tour',
        slug: `overlapping-tour-${Date.now()}`,
        overview:
          'A tour whose pricing periods overlap, which is ambiguous and must be rejected at validation time rather than silently resolved.',
        duration: 5,
        duration_unit: 'days',
        pricing_periods: [
          {
            start_date: '2026-01-01',
            end_date: '2026-07-15',
            pricing_tiers: [{ pax: 2, price_per_person: 800, currency: 'USD' }],
          },
          {
            start_date: '2026-07-01',
            end_date: '2026-12-31',
            pricing_tiers: [{ pax: 2, price_per_person: 900, currency: 'USD' }],
          },
        ],
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'published',
      };

      const response = await adminAgent.post('/api/tours').send(tourData);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    it('should fail without required fields', async () => {
      const incompleteData = {
        title: 'Incomplete Tour',
        // Missing required fields
      };

      const response = await adminAgent
        .post('/api/tours')
        .send(incompleteData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation error');
    });

    it('should block regular user from creating tour', async () => {
      const userAuth = await createAuthenticatedAgent(app, redis);
      const userAgent = userAuth.agent;

      const tourData = {
        title: 'Unauthorized Tour',
        slug: `unauthorized-${Date.now()}`,
        overview:
          'This tour should not be created by a regular user. Only administrators have permission to create new tour packages.',
        duration: 3,
        duration_unit: 'days',
        pricing: {
          amount: 1000,
          currency: 'USD',
        },
        destination_ids: [testDestination.id],
        images: ['https://example.com/image1.jpg'],
        status: 'draft',
      };

      await userAgent.post('/api/tours').send(tourData).expect(403);

      // Cleanup
      await redis.del(`sess:${userAuth.sessionId}`);
    });
  });

  // ========================================
  // TEST SUITE 2: GET /api/tours - Get All Tours (Public)
  // ========================================
  describe('GET /api/tours - Get All Tours', () => {
    let testTour;
    let testDestination;

    beforeEach(async () => {
      testDestination = await createTestDestination();

      // Create a test tour
      const [tour] = await db
        .insert(tours)
        .values({
          title: 'Public Test Tour',
          slug: `public-tour-${Date.now()}`,
          overview:
            'A publicly visible tour for testing the get all tours endpoint with proper filtering and pagination support.',
          duration: 3,
          duration_unit: 'days',
          price_amount: '1000',
          price_currency: 'USD',
          discount_percentage: '0',
          images: ['https://example.com/image.jpg'],
          status: 'published',
          featured: true,
        })
        .returning();

      testTour = tour;

      // Link tour to destination
      await db.insert(tourDestinations).values({
        tour_id: tour.id,
        destination_id: testDestination.id,
        order: 0,
      });
    });

    afterEach(async () => {
      await db.delete(tours).where(eq(tours.id, testTour.id));
      await deleteTestDestination(testDestination.id);
    });

    it('should get all published tours (public access)', async () => {
      const response = await request(app).get('/api/tours').expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/tours?page=1&limit=5')
        .expect(200);

      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(5);
    });

    it('should filter by featured status', async () => {
      const response = await request(app)
        .get('/api/tours?featured=true')
        .expect(200);

      expect(response.body.success).toBe(true);
      // All returned tours should be featured
      if (response.body.data.length > 0) {
        response.body.data.forEach((tour) => {
          expect(tour.featured).toBe(true);
        });
      }
    });

    it('should filter by destination', async () => {
      const response = await request(app)
        .get(`/api/tours?destination_id=${testDestination.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should search tours by title', async () => {
      const response = await request(app)
        .get('/api/tours?search=test')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should sort by price', async () => {
      const response = await request(app)
        .get('/api/tours?sort_by=price&sort_order=asc')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  // ========================================
  // TEST SUITE 3: GET /api/tours/:id - Get Tour by ID
  // ========================================
  describe('GET /api/tours/:id - Get Tour by ID', () => {
    let testTour;
    let testDestination;

    beforeEach(async () => {
      testDestination = await createTestDestination();

      const [tour] = await db
        .insert(tours)
        .values({
          title: 'Single Tour Test',
          slug: `single-tour-${Date.now()}`,
          overview:
            'A tour for testing individual tour retrieval with all associated data including destinations and pricing information.',
          duration: 4,
          duration_unit: 'days',
          price_amount: '1200',
          price_currency: 'USD',
          // Mirrors what the service derives from the compare-at tier below
          discount_percentage: '25',
          pricing_periods: [
            buildTestPricingPeriod({
              pricing_tiers: [
                {
                  pax: 2,
                  price_per_person: 600,
                  compare_at_price: 800,
                  currency: 'USD',
                },
              ],
            }),
          ],
          images: ['https://example.com/image.jpg'],
          status: 'published',
        })
        .returning();

      testTour = tour;

      await db.insert(tourDestinations).values({
        tour_id: tour.id,
        destination_id: testDestination.id,
        order: 0,
      });
    });

    afterEach(async () => {
      await db.delete(tours).where(eq(tours.id, testTour.id));
      await deleteTestDestination(testDestination.id);
    });

    it('should get tour by valid ID', async () => {
      const response = await request(app)
        .get(`/api/tours/${testTour.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testTour.id);
      expect(response.body.data).toHaveProperty('pricing_display');
      expect(response.body.data).toHaveProperty('is_currently_bookable');
    });

    it('should return 404 for non-existent tour', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const response = await request(app)
        .get(`/api/tours/${fakeId}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Tour not found');
    });

    it('should include pricing display information', async () => {
      const response = await request(app)
        .get(`/api/tours/${testTour.id}`)
        .expect(200);

      expect(response.body.data.pricing_display).toBeDefined();
      expect(response.body.data.pricing_display).toHaveProperty(
        'display_price'
      );
      expect(response.body.data.pricing_display).toHaveProperty('has_periods');
      expect(response.body.data.pricing_display.has_periods).toBe(true);
      expect(response.body.data.pricing_display.periods).toHaveLength(1);
      // Reads from the nested pricing object, not the stripped flat columns
      expect(response.body.data.pricing_display.currency).toBe('USD');
      expect(response.body.data.pricing_display.currency_symbol).toBe('$');
      expect(response.body.data.pricing_display.has_discount).toBe(true);
      expect(response.body.data.pricing_display.discount_percentage).toBe(25);
      // The displayed price is the charged one, not the compare-at
      expect(response.body.data.pricing_display.display_price).toContain('600');
    });
  });

  // ========================================
  // TEST SUITE 4: PATCH /api/tours/:id - Update Tour (Admin Only)
  // ========================================
  describe('PATCH /api/tours/:id - Update Tour', () => {
    let adminAgent;
    let testAdmin;
    let adminSessionId;
    let testTour;
    let testDestination;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;

      testDestination = await createTestDestination();

      const [tour] = await db
        .insert(tours)
        .values({
          title: 'Tour to Update',
          slug: `update-tour-${Date.now()}`,
          overview:
            'This tour will be updated during testing to verify that all fields can be properly modified by administrators.',
          duration: 3,
          duration_unit: 'days',
          price_amount: '1000',
          price_currency: 'USD',
          discount_percentage: '0',
          images: ['https://example.com/image.jpg'],
          status: 'draft',
        })
        .returning();

      testTour = tour;
    });

    afterEach(async () => {
      await db.delete(tours).where(eq(tours.id, testTour.id));
      await deleteTestDestination(testDestination.id);
      await deleteTestAdmin(testAdmin.id);
      await redis.del(`sess:${adminSessionId}`);
    });

    it('should update tour title', async () => {
      const updates = {
        title: 'Updated Tour Title',
      };

      const response = await adminAgent
        .patch(`/api/tours/${testTour.id}`)
        .send(updates)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe('Updated Tour Title');
    });

    it('should update tour pricing', async () => {
      const updates = {
        pricing: {
          amount: 1500,
          currency: 'USD',
          discount_percentage: 15,
        },
      };

      const response = await adminAgent
        .patch(`/api/tours/${testTour.id}`)
        .send(updates)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.pricing.amount).toBe(1500);
    });

    it('should update tour status', async () => {
      const updates = {
        status: 'published',
      };

      const response = await adminAgent
        .patch(`/api/tours/${testTour.id}`)
        .send(updates)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('published');
    });

    it('should block regular user from updating tour', async () => {
      const userAuth = await createAuthenticatedAgent(app, redis);

      const updates = {
        title: 'Unauthorized Update',
      };

      await userAuth.agent
        .patch(`/api/tours/${testTour.id}`)
        .send(updates)
        .expect(403);

      // Cleanup
      await redis.del(`sess:${userAuth.sessionId}`);
    });

    it('should return 404 for non-existent tour', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const response = await adminAgent
        .patch(`/api/tours/${fakeId}`)
        .send({ title: 'New Title' })
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // TEST SUITE 5: DELETE /api/tours/:id - Delete Tour (Admin Only)
  // ========================================
  describe('DELETE /api/tours/:id - Delete Tour', () => {
    let adminAgent;
    let testAdmin;
    let adminSessionId;
    let testTour;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;
      adminSessionId = adminAuth.sessionId;

      const [tour] = await db
        .insert(tours)
        .values({
          title: 'Tour to Delete',
          slug: `delete-tour-${Date.now()}`,
          overview:
            'This tour will be deleted during testing to verify proper cleanup of all associated data and relationships.',
          duration: 3,
          duration_unit: 'days',
          price_amount: '1000',
          price_currency: 'USD',
          images: ['https://example.com/image.jpg'],
          status: 'draft',
        })
        .returning();

      testTour = tour;
    });

    afterEach(async () => {
      // Try to clean up if test failed
      try {
        await db.delete(tours).where(eq(tours.id, testTour.id));
      } catch {
        // Tour already deleted, ignore
      }

      await deleteTestAdmin(testAdmin.id);
      await redis.del(`sess:${adminSessionId}`);
    });

    it('should delete tour successfully', async () => {
      const response = await adminAgent
        .delete(`/api/tours/${testTour.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Tour deleted successfully');

      // Verify tour is deleted
      const [deletedTour] = await db
        .select()
        .from(tours)
        .where(eq(tours.id, testTour.id));

      expect(deletedTour).toBeUndefined();
    });

    it('should block regular user from deleting tour', async () => {
      const userAuth = await createAuthenticatedAgent(app, redis);

      await userAuth.agent.delete(`/api/tours/${testTour.id}`).expect(403);

      // Cleanup
      await redis.del(`sess:${userAuth.sessionId}`);
    });

    it('should return 404 for non-existent tour', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      await adminAgent.delete(`/api/tours/${fakeId}`).expect(404);
    });
  });

  // ========================================
  // TEST SUITE 6: Special Endpoints
  // ========================================
  describe('Special Tour Endpoints', () => {
    let testTour;

    beforeEach(async () => {
      const [tour] = await db
        .insert(tours)
        .values({
          title: 'Featured Deal Tour',
          slug: `special-tour-${Date.now()}`,
          overview:
            'A special tour for testing featured and deals endpoints with discounts and promotional pricing options.',
          duration: 5,
          duration_unit: 'days',
          price_amount: '1600',
          price_currency: 'USD',
          // A genuine live offer: charged 1600, was 2000 -> 20% off
          compare_at_amount: '2000',
          discount_percentage: '20',
          images: ['https://example.com/image.jpg'],
          featured: true,
          is_deal: true,
          status: 'published',
        })
        .returning();

      testTour = tour;
    });

    afterEach(async () => {
      await db.delete(tours).where(eq(tours.id, testTour.id));
    });

    it('GET /api/tours/featured - should get featured tours', async () => {
      const response = await request(app)
        .get('/api/tours/featured')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('GET /api/tours/deals - should get deal tours', async () => {
      await cache.delPattern(CacheKeys.patterns.toursDeals());
      const response = await request(app).get('/api/tours/deals').expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      // The fixture has a live compare-at offer, so it must be listed
      expect(response.body.data.map((t) => t.id)).toContain(testTour.id);
    });

    it('GET /api/tours/deals - should exclude a tour whose only offer has expired', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const key = (offset) =>
        new Date(Date.now() + offset * dayMs).toISOString().split('T')[0];

      const [expired] = await db
        .insert(tours)
        .values({
          title: 'Expired Promo Tour',
          slug: `expired-promo-${Date.now()}`,
          overview:
            'A tour whose discounted season finished months ago and must therefore drop out of the deals carousel entirely.',
          duration: 5,
          duration_unit: 'days',
          // Stale write-time summary — deliberately non-zero, to prove
          // eligibility is not decided by this column
          discount_percentage: '50',
          pricing_periods: [
            {
              label: 'Expired',
              start_date: key(-200),
              end_date: key(-100),
              pricing_tiers: [
                {
                  pax: 2,
                  price_per_person: 500,
                  compare_at_price: 1000,
                  currency: 'USD',
                },
              ],
            },
          ],
          images: ['https://example.com/image.jpg'],
          is_deal: true,
          status: 'published',
        })
        .returning();

      try {
        await cache.delPattern(CacheKeys.patterns.toursDeals());
        const response = await request(app).get('/api/tours/deals').expect(200);

        const ids = response.body.data.map((t) => t.id);
        expect(ids).not.toContain(expired.id);
        // ...while a tour with a live offer is still there
        expect(ids).toContain(testTour.id);
      } finally {
        await db.delete(tours).where(eq(tours.id, expired.id));
        await cache.delPattern(CacheKeys.patterns.toursDeals());
      }
    });

    it('GET /api/tours/deals - should attach destinations to each deal', async () => {
      // getDeals keeps its own raw-SQL select instead of the relational query
      // builder, so destinations arrive via a follow-up query. If that
      // regresses, every deal card silently loses its location line.
      const destination = await createTestDestination();

      const [withDest] = await db
        .insert(tours)
        .values({
          title: 'Deal With Destination',
          slug: `deal-with-destination-${Date.now()}`,
          overview:
            'A discounted tour linked to a destination, proving the deals endpoint returns the location data its cards render.',
          duration: 3,
          duration_unit: 'days',
          price_amount: '750',
          price_currency: 'USD',
          compare_at_amount: '1000',
          discount_percentage: '25',
          images: ['https://example.com/image.jpg'],
          is_deal: true,
          status: 'published',
        })
        .returning();

      await db.insert(tourDestinations).values({
        tour_id: withDest.id,
        destination_id: destination.id,
        order: 0,
      });

      try {
        await cache.delPattern(CacheKeys.patterns.toursDeals());
        const response = await request(app).get('/api/tours/deals').expect(200);

        // Always an array, including for the fixture tour that has none —
        // cards branch on `.length` and would throw on undefined
        for (const deal of response.body.data) {
          expect(Array.isArray(deal.destinations)).toBe(true);
        }

        const deal = response.body.data.find((t) => t.id === withDest.id);
        expect(deal).toBeDefined();
        expect(deal.destinations).toHaveLength(1);
        expect(deal.destinations[0].id).toBe(destination.id);
        expect(deal.destinations[0].title).toBe(destination.title);
      } finally {
        await db.delete(tours).where(eq(tours.id, withDest.id));
        await deleteTestDestination(destination.id);
        await cache.delPattern(CacheKeys.patterns.toursDeals());
      }
    });

    it('GET /api/tours/search - should search tours', async () => {
      const response = await request(app)
        .get('/api/tours/search?q=test')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should fail search without query', async () => {
      const response = await request(app).get('/api/tours/search').expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/tours/stats/top-performing - Get Top Performing Tours', () => {
    let adminAgent;
    let testAdmin;
    let agent;
    let testUser;

    beforeEach(async () => {
      const adminAuth = await createAuthenticatedAdminAgent(app);
      adminAgent = adminAuth.agent;
      testAdmin = adminAuth.user;

      const userAuth = await createAuthenticatedAgent(app, redis);
      agent = userAuth.agent;
      testUser = userAuth.user;
    });

    afterEach(async () => {
      await deleteTestAdmin(testAdmin.id);
      await deleteTestUser(testUser.id);
    });

    it('should return top performing tours by revenue without crashing', async () => {
      const response = await adminAgent
        .get('/api/tours/stats/top-performing?metric=revenue')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data.tours)).toBe(true);
      expect(response.body.data).toHaveProperty('top_tour');
    });

    it('should return top performing tours by bookings without crashing', async () => {
      const response = await adminAgent
        .get('/api/tours/stats/top-performing?metric=bookings')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data.tours)).toBe(true);
      expect(response.body.data).toHaveProperty('top_tour');
    });

    it('should fail without authentication', async () => {
      await request(app).get('/api/tours/stats/top-performing').expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.get('/api/tours/stats/top-performing').expect(403);
    });
  });
});
