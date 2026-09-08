// ============================================
// FILE 5: src/__tests__/integration/bookings.test.js
// ============================================
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js'; // ✅ Add this
import redis from '#config/redis.js';
import { bookings } from '#models/booking.model.js';
import { user } from '#models/user.model.js';
import {
  cleanupTestSession,
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  deleteTestAdmin,
  createMockUser,
} from '../helpers/auth.helper.js';
import {
  createTestTour,
  deleteTestTour,
  buildTestPricingPeriod,
} from '../helpers/tour.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

describe('Booking API Integration Tests', () => {
  let agent;
  let testTour;
  let testUser;
  let sessionId;

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    testTour = await createTestTour();

    // ✅ createAuthenticatedAgent now creates real DB user
    const auth = await createAuthenticatedAgent(app, redis);
    agent = auth.agent;
    testUser = auth.user;
    sessionId = auth.sessionId;
  });

  afterEach(async () => {
    await db.delete(bookings).where(eq(bookings.tour_id, testTour.id));
    await deleteTestTour(testTour.id);
    await deleteTestUser(testUser.id); // ✅ Clean up real user
    await cleanupTestSession(redis, sessionId);
  });

  afterAll(async () => {
    await redis.quit();
  });

  // ========================================
  // TEST 1: Create Booking - Success
  // ========================================
  describe('POST /api/bookings - Create Booking', () => {
    it('should create a booking successfully with valid data', async () => {
      const bookingData = {
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
        special_requests: 'Vegetarian meals please',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('booking_reference');
      expect(response.body.data.group_size).toBe(2);
      expect(response.body.data.status).toBe('pending');
      expect(response.body.data.payment_status).toBe('pending');
      expect(response.body.message).toBe('Booking created successfully');
    });

    // ========================================
    // TEST 2: Create Booking - Missing Required Fields
    // ========================================
    it('should fail when required fields are missing', async () => {
      const incompleteData = {
        tour_id: testTour.id,
        group_size: 2,
        // Missing other required fields
      };

      const response = await agent
        .post('/api/bookings')
        .send(incompleteData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Validation error');
    });

    // ========================================
    // TEST 3: Create Booking - Invalid Tour ID
    // ========================================
    it('should fail with invalid tour ID', async () => {
      const bookingData = {
        tour_id: 'non-existent-tour-id',
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    // ========================================
    // TEST 4: Create Booking - Unauthorized
    // ========================================
    it('should fail without authentication', async () => {
      const bookingData = {
        tour_id: testTour.id,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      // Use regular request without session
      await request(app).post('/api/bookings').send(bookingData).expect(401);
    });

    // ========================================
    // TEST 5: Create Booking - Group Size Validation
    // ========================================
    it('should fail with group size exceeding maximum', async () => {
      const bookingData = {
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 100, // Exceeds max
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(400);

      expect(response.body.success).toBe(false);
      // ✅ Just check that there's an error, don't rely on exact message
      const errorMessage = response.body.error || response.body.message || '';
      expect(errorMessage.length).toBeGreaterThan(0);
    });
    // ========================================
    // TEST 6: Create Booking - Pricing Tier Calculation
    // ========================================
    it('should calculate correct price based on pricing tier', async () => {
      const bookingData = {
        tour_id: testTour.id,
        selected_tier_index: 1,
        group_size: 4, // Should use tier 2: $495/person
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(201);

      expect(response.body.data.price_per_person).toBe('495.00');
      expect(response.body.data.total_price).toBe('1980.00');
      expect(response.body.data.currency).toBe('USD');
    });

    // ========================================
    // TEST 6a: A tier on offer charges the entered price, not the compare-at
    // ========================================
    it('should charge the entered price, never the compare-at price', async () => {
      // The regression this pricing model exists to prevent
      const onOfferTour = await createTestTour({
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
      });

      try {
        const response = await agent
          .post('/api/bookings')
          .send({
            tour_id: onOfferTour.id,
            group_size: 2,
            start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0],
            end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0],
            customer_name: 'John Doe',
            customer_email: 'john@example.com',
            customer_phone: '+254700000000',
            country: 'KE',
          })
          .expect(201);

        expect(response.body.data.price_per_person).toBe('600.00');
        expect(response.body.data.total_price).toBe('1200.00');
      } finally {
        await db.delete(bookings).where(eq(bookings.tour_id, onOfferTour.id));
        await deleteTestTour(onOfferTour.id);
      }
    });

    // ========================================
    // TEST 6b: Group size between tiers uses closest tier at-or-below
    // ========================================
    it('should charge the closest tier at or below for an in-between group', async () => {
      // Helper tiers are 2/4/6 pax at 585/495/432 — a group of 3 pays the
      // 2-pax rate of 585, not the 4-pax rate.
      const bookingData = {
        tour_id: testTour.id,
        group_size: 3,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(201);

      expect(response.body.data.price_per_person).toBe('585.00');
      expect(response.body.data.total_price).toBe('1755.00'); // 585 * 3
    });

    // ========================================
    // TEST 6c: A client cannot pick a cheaper tier than it qualifies for
    // ========================================
    it('should reject a selected tier that disagrees with group size', async () => {
      const bookingData = {
        tour_id: testTour.id,
        selected_tier_index: 2, // 6-pax rate of 432 — cheapest tier
        group_size: 2, // but only 2 people are travelling
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(400);

      expect(response.body.success).toBe(false);
      const errorMessage = response.body.error || response.body.message || '';
      expect(errorMessage).toMatch(/does not match your group size/i);
    });

    // ========================================
    // TEST 6d: Dates outside every pricing period are rejected
    // ========================================
    it('should reject a booking whose dates no pricing period covers', async () => {
      // The helper period ends 365 days out; book well beyond it
      const bookingData = {
        tour_id: testTour.id,
        group_size: 2,
        start_date: new Date(Date.now() + 500 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 503 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      const response = await agent
        .post('/api/bookings')
        .send(bookingData)
        .expect(400);

      expect(response.body.success).toBe(false);
      const errorMessage = response.body.error || response.body.message || '';
      expect(errorMessage).toMatch(/custom quote/i);
    });
    it('should return 400 when all pricing periods have expired', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const key = (offsetDays) =>
        new Date(Date.now() + offsetDays * dayMs).toISOString().split('T')[0];

      const expiredTour = await createTestTour({
        pricing_periods: [
          buildTestPricingPeriod({
            label: 'Expired Season',
            start_date: key(-400),
            end_date: key(-100),
          }),
        ],
      });

      const response = await agent
        .post('/api/bookings')
        .send({
          tour_id: expiredTour.id,
          selected_tier_index: 0,
          group_size: 2,
          start_date: key(30),
          end_date: key(33),
          customer_name: 'John Doe',
          customer_email: 'john@example.com',
          customer_phone: '+254700000000',
          country: 'KE',
        })
        .expect(400);

      expect(response.body.success).toBe(false);

      await deleteTestTour(expiredTour.id);
    });
  });

  // ========================================
  // TEST 7: Get User Bookings
  // ========================================
  describe('GET /api/bookings/my-bookings - Get User Bookings', () => {
    it('should return user bookings', async () => {
      // First create a booking
      const bookingData = {
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      };

      await agent.post('/api/bookings').send(bookingData);

      // Now fetch user bookings
      const response = await agent.get('/api/bookings/my-bookings').expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });

  // ========================================
  // TEST 8: Get Booking by ID
  // ========================================
  describe('GET /api/bookings/:id - Get Booking by ID', () => {
    it('should return booking details for valid ID', async () => {
      // Create a booking first
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const bookingId = createResponse.body.data.id;

      // Fetch the booking
      const response = await agent
        .get(`/api/bookings/${bookingId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(bookingId);
    });

    it('should return 404 for non-existent booking', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      await agent.get(`/api/bookings/${fakeId}`).expect(404);
    });
  });

  describe('GET /api/bookings/stats/revenue - Get Revenue Stats', () => {
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

    it('should return revenue stats without crashing', async () => {
      const response = await adminAgent
        .get('/api/bookings/stats/revenue')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('monthly_data');
      expect(response.body.data).toHaveProperty('total_revenue');
      expect(response.body.data).toHaveProperty('total_bookings');
    });

    it('should fail without authentication', async () => {
      await request(app).get('/api/bookings/stats/revenue').expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.get('/api/bookings/stats/revenue').expect(403);
    });
  });

  describe('GET /api/bookings/:id/pnl - Booking P&L', () => {
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

    // Created through the API, like every other booking in this suite, so the
    // receivable is raised the way it is in production rather than by an
    // insert that skips the ledger.
    const newBooking = async () => {
      const response = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });
      return response.body.data.id;
    };

    it('tells caches not to keep the figures', async () => {
      const bookingId = await newBooking();
      const response = await adminAgent
        .get(`/api/bookings/${bookingId}/pnl`)
        .expect(200);

      // What a trip made is the operator's commercial position, and helmet
      // sets no cache policy of its own — without this a shared cache or a
      // browser on a shared machine can hold it past the session that was
      // allowed to see it.
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.data).toHaveProperty('margin');
    });

    it('answers 400 for a malformed id rather than 500', async () => {
      await adminAgent.get('/api/bookings/not-a-uuid/pnl').expect(400);
    });

    it('fails without authentication', async () => {
      const bookingId = await newBooking();
      await request(app).get(`/api/bookings/${bookingId}/pnl`).expect(401);
    });

    it('fails for a non-admin', async () => {
      const bookingId = await newBooking();
      await agent.get(`/api/bookings/${bookingId}/pnl`).expect(403);
    });
  });

  describe('GET /api/bookings/stats/trends - Get Booking Trends', () => {
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

    it('should return booking trends without crashing', async () => {
      const response = await adminAgent
        .get('/api/bookings/stats/trends')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('monthly_data');
      expect(response.body.data).toHaveProperty('total_bookings');
      expect(response.body.data).toHaveProperty('avg_per_month');
      expect(response.body.data).toHaveProperty('trend');
    });

    it('should fail without authentication', async () => {
      await request(app).get('/api/bookings/stats/trends').expect(401);
    });

    it('should fail with non-admin user', async () => {
      await agent.get('/api/bookings/stats/trends').expect(403);
    });
  });

  // ========================================
  // TEST 9: Cancel Booking
  // ========================================
  describe('PATCH /api/bookings/:id/cancel - Cancel Booking', () => {
    it('should cancel a booking successfully', async () => {
      // Create a booking first
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const bookingId = createResponse.body.data.id;

      // Cancel the booking
      const response = await agent
        .patch(`/api/bookings/${bookingId}/cancel`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('cancelled');
      expect(response.body.message).toBe('Booking cancelled successfully');
    });
  });

  describe('PATCH /api/bookings/:id - Update Booking', () => {
    it('should ignore protected fields (payment_status, total_price, status, user_id) sent by the client', async () => {
      // Create a booking first
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const booking = createResponse.body.data;

      const maliciousPayload = {
        special_requests: 'Extra towels please',
        payment_status: 'paid',
        status: 'confirmed',
        total_price: '1.00',
        user_id: 'some-other-user-id',
      };

      const response = await agent
        .patch(`/api/bookings/${booking.id}`)
        .send(maliciousPayload)
        .expect(200);

      // Legit field WAS updated
      expect(response.body.data.special_requests).toBe('Extra towels please');

      // Protected fields were NOT updated to the attacker-supplied values
      expect(response.body.data.payment_status).toBe(booking.payment_status);
      expect(response.body.data.status).toBe(booking.status);
      expect(response.body.data.total_price).toBe(booking.total_price);
      expect(response.body.data.user_id).toBe(booking.user_id);
    });

    it('should return 400 when no valid editable fields are provided', async () => {
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const bookingId = createResponse.body.data.id;

      const response = await agent
        .patch(`/api/bookings/${bookingId}`)
        .send({ payment_status: 'paid' })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should let an admin re-price a booking, recomputing the total from the rate', async () => {
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const booking = createResponse.body.data;

      const adminAuth = await createAuthenticatedAdminAgent(app);

      try {
        const response = await adminAuth.agent
          .patch(`/api/bookings/${booking.id}`)
          // total_price is deliberately inconsistent: it must be ignored and
          // recomputed from the rate and the stored group size
          .send({ price_per_person: 500, total_price: '1.00' })
          .expect(200);

        expect(parseFloat(response.body.data.price_per_person)).toBe(500);
        expect(parseFloat(response.body.data.total_price)).toBe(1000); // 500 x 2
      } finally {
        await deleteTestAdmin(adminAuth.user.id);
      }
    });

    it('should keep the total consistent with the stored rate for fractional prices', async () => {
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const booking = createResponse.body.data;
      const adminAuth = await createAuthenticatedAdminAgent(app);

      try {
        // A rate carrying a fraction of a cent used to round independently of
        // the total, persisting 1.00 per person against a total of 2.01.
        const response = await adminAuth.agent
          .patch(`/api/bookings/${booking.id}`)
          .send({ price_per_person: 1.005 })
          .expect(200);

        const storedRate = parseFloat(response.body.data.price_per_person);
        const storedTotal = parseFloat(response.body.data.total_price);

        expect(storedTotal).toBeCloseTo(
          storedRate * response.body.data.group_size,
          2
        );
      } finally {
        await deleteTestAdmin(adminAuth.user.id);
      }
    });

    it('should reject a non-positive price from an admin', async () => {
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const adminAuth = await createAuthenticatedAdminAgent(app);

      try {
        const response = await adminAuth.agent
          .patch(`/api/bookings/${createResponse.body.data.id}`)
          .send({ price_per_person: 0 })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.details[0].message).toBe(
          'Price per person must be positive'
        );

        const nonNumeric = await adminAuth.agent
          .patch(`/api/bookings/${createResponse.body.data.id}`)
          .send({ price_per_person: 'free' })
          .expect(400);

        expect(nonNumeric.body.details[0].message).toBe(
          'Price per person must be a number'
        );
      } finally {
        await deleteTestAdmin(adminAuth.user.id);
      }
    });

    it('should ignore price_per_person sent by the booking owner', async () => {
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const booking = createResponse.body.data;

      const response = await agent
        .patch(`/api/bookings/${booking.id}`)
        .send({ special_requests: 'Window seat', price_per_person: 1 })
        .expect(200);

      expect(response.body.data.special_requests).toBe('Window seat');
      expect(response.body.data.price_per_person).toBe(
        booking.price_per_person
      );
      expect(response.body.data.total_price).toBe(booking.total_price);
    });

    it('should reject invalid values for editable fields (e.g. malformed email)', async () => {
      const createResponse = await agent.post('/api/bookings').send({
        tour_id: testTour.id,
        selected_tier_index: 0,
        group_size: 2,
        start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
        customer_name: 'John Doe',
        customer_email: 'john@example.com',
        customer_phone: '+254700000000',
        country: 'KE',
      });

      const bookingId = createResponse.body.data.id;

      const response = await agent
        .patch(`/api/bookings/${bookingId}`)
        .send({ customer_email: 'not-a-valid-email' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  // ========================================
  // TEST 10: Session Persistence
  // ========================================
  describe('Session Management', () => {
    it('should maintain session across multiple requests', async () => {
      // Make multiple requests with the same agent
      await agent.get('/api/bookings/my-bookings').expect(200);
      await agent.get('/api/bookings/my-bookings').expect(200);

      // Session should still be valid
      const response = await agent.get('/api/bookings/my-bookings').expect(200);
      expect(response.body.success).toBe(true);
    });

    // it('should fail with invalid session', async () => {
    //   const invalidAgent = request.agent(app);
    //   invalidAgent.set('Cookie', ['sid=invalid-session-id']);

    //   await invalidAgent.get('/api/bookings/my-bookings').expect(401);
    // });
    it('should fail with invalid session', async () => {
      const invalidAgent = request.agent(app);
      invalidAgent.set('Cookie', [
        'better-auth.session_token=invalid-session-token',
      ]);

      await invalidAgent.get('/api/bookings/my-bookings').expect(401);
    });
  });
  describe('Data Integrity - User Deletion', () => {
    it('should preserve booking history when user is deleted, nulling out user_id', async () => {
      const userToDelete = await createMockUser();

      const [booking] = await db
        .insert(bookings)
        .values({
          tenant_id: SEED_TENANT_ID,
          tour_id: testTour.id,
          user_id: userToDelete.id,
          group_size: 2,
          start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
          price_per_person_cents: 50000,
          total_price_cents: 100000,
          currency: 'USD',
          customer_name: 'John Doe',
          customer_email: 'john@example.com',
          customer_phone: '+254700000000',
          country: 'KE',
          booking_reference: `FA-TEST-${Date.now().toString().slice(-8)}`,
        })
        .returning();

      await db.delete(user).where(eq(user.id, userToDelete.id));

      const [survivedBooking] = await db
        .select()
        .from(bookings)
        .where(eq(bookings.id, booking.id));

      expect(survivedBooking).toBeDefined();
      expect(survivedBooking.user_id).toBeNull();
    });
  });
});
