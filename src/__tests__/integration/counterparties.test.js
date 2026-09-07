// src/__tests__/integration/counterparties.test.js
//
// The cost side's first writer. These go through the HTTP surface rather than
// the service directly, so they exercise the admin guard, the tenant
// middleware and RLS along with the CRUD itself.

import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { counterparties, obligations } from '#models/money.model.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

describe('Counterparty API Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;
  const created = [];

  const supplier = (overrides = {}) => ({
    type: 'supplier',
    name: `Mara Serena Lodge ${Date.now()}`,
    email: 'reservations@example.com',
    default_currency: 'USD',
    payment_terms_days: 30,
    ...overrides,
  });

  const track = (body) => {
    if (body?.data?.id) created.push(body.data.id);
    return body;
  };

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    const userAuth = await createAuthenticatedAgent(app, redis);
    agent = userAuth.agent;
    testUser = userAuth.user;
    sessionId = userAuth.sessionId;

    const adminAuth = await createAuthenticatedAdminAgent(app);
    adminAgent = adminAuth.agent;
    testAdmin = adminAuth.user;
    adminSessionId = adminAuth.sessionId;
  });

  afterEach(async () => {
    while (created.length) {
      const id = created.pop();
      await db.delete(obligations).where(eq(obligations.counterparty_id, id));
      await db.delete(counterparties).where(eq(counterparties.id, id));
    }
    await deleteTestUser(testUser.id);
    await deleteTestUser(testAdmin.id);
    await cleanupTestSession(redis, sessionId);
    await cleanupTestSession(redis, adminSessionId);
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe('access control', () => {
    it('refuses an unauthenticated caller', async () => {
      await request(app).get('/api/counterparties').expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      const response = await agent.get('/api/counterparties');
      expect(response.status).toBe(403);
    });

    it('allows an admin', async () => {
      const response = await adminAgent.get('/api/counterparties').expect(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('POST /api/counterparties', () => {
    it('creates a supplier', async () => {
      const response = await adminAgent
        .post('/api/counterparties')
        .send(supplier())
        .expect(201);

      track(response.body);
      expect(response.body.data.type).toBe('supplier');
      expect(response.body.data.default_currency).toBe('USD');
      expect(response.body.data.payment_terms_days).toBe(30);
      expect(response.body.data.is_active).toBe(true);
      // Never taken from caller input, whatever it sends.
      expect(response.body.data.tenant_id).toBe(SEED_TENANT_ID);
    });

    it('assigns the tenant itself, ignoring a supplied one', async () => {
      const response = await adminAgent
        .post('/api/counterparties')
        .send(supplier({ tenant_id: '00000000-0000-0000-0000-0000000000ff' }))
        .expect(201);

      track(response.body);
      expect(response.body.data.tenant_id).toBe(SEED_TENANT_ID);
    });

    it('requires a commission rate on an agent', async () => {
      const response = await adminAgent
        .post('/api/counterparties')
        .send({ type: 'agent', name: 'Nairobi Travel Co' })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(JSON.stringify(response.body.details)).toMatch(
        /commission_rate_bps/
      );
    });

    it('refuses a commission rate on a supplier', async () => {
      const response = await adminAgent
        .post('/api/counterparties')
        .send(supplier({ commission_rate_bps: 1250 }))
        .expect(400);

      expect(JSON.stringify(response.body.details)).toMatch(
        /only applies to an agent/
      );
    });

    it('refuses a commission rate above 100%', async () => {
      const response = await adminAgent
        .post('/api/counterparties')
        .send({ type: 'agent', name: 'Greedy Co', commission_rate_bps: 10001 })
        .expect(400);

      expect(JSON.stringify(response.body.details)).toMatch(/10000/);
    });

    it('accepts an agent with a commission rate in basis points', async () => {
      const response = await adminAgent
        .post('/api/counterparties')
        .send({
          type: 'agent',
          name: `Nairobi Travel ${Date.now()}`,
          commission_rate_bps: 1250,
        })
        .expect(201);

      track(response.body);
      // 12.5% stored as an integer, never a float.
      expect(response.body.data.commission_rate_bps).toBe(1250);
    });
  });

  describe('GET /api/counterparties', () => {
    it('filters by type', async () => {
      track(
        (await adminAgent.post('/api/counterparties').send(supplier())).body
      );

      const response = await adminAgent
        .get('/api/counterparties?type=supplier')
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      response.body.data.forEach((row) => expect(row.type).toBe('supplier'));
    });

    it('searches case-insensitively', async () => {
      const name = `Amboseli Camp ${Date.now()}`;
      track(
        (await adminAgent.post('/api/counterparties').send(supplier({ name })))
          .body
      );

      const response = await adminAgent
        .get('/api/counterparties?search=amboseli')
        .expect(200);

      expect(response.body.data.some((r) => r.name === name)).toBe(true);
    });

    it('returns a total alongside the page', async () => {
      const response = await adminAgent
        .get('/api/counterparties?page=1&limit=1')
        .expect(200);

      expect(response.body.limit).toBe(1);
      expect(typeof response.body.total).toBe('number');
    });

    it('rejects a page of zero', async () => {
      await adminAgent.get('/api/counterparties?page=0').expect(400);
    });
  });

  describe('PATCH /api/counterparties/:id', () => {
    it('does not reset fields a patch never mentioned', async () => {
      const { body } = await adminAgent
        .post('/api/counterparties')
        .send(supplier({ default_currency: 'USD' }));
      track(body);

      const response = await adminAgent
        .patch(`/api/counterparties/${body.data.id}`)
        .send({ notes: 'Prefers email' })
        .expect(200);

      // The .partial() trap: a create-schema default would have pulled this
      // back to KES on a patch that never mentioned currency.
      expect(response.body.data.default_currency).toBe('USD');
      expect(response.body.data.is_active).toBe(true);
      expect(response.body.data.notes).toBe('Prefers email');
    });

    it('judges a patch on the record it produces, not on the patch', async () => {
      const { body } = await adminAgent
        .post('/api/counterparties')
        .send(supplier());
      track(body);

      // {"type":"agent"} on its own says nothing about a commission rate, so a
      // check against the patch alone passes and stores an agent that earns
      // nothing — invisible until somebody reconciles a payable that should
      // have existed.
      const response = await adminAgent
        .patch(`/api/counterparties/${body.data.id}`)
        .send({ type: 'agent' })
        .expect(400);

      expect(JSON.stringify(response.body.details)).toMatch(
        /commission_rate_bps/
      );
    });

    it('refuses a commission rate patched onto a supplier', async () => {
      const { body } = await adminAgent
        .post('/api/counterparties')
        .send(supplier());
      track(body);

      const response = await adminAgent
        .patch(`/api/counterparties/${body.data.id}`)
        .send({ commission_rate_bps: 500 })
        .expect(400);

      expect(JSON.stringify(response.body.details)).toMatch(
        /only applies to an agent/
      );
    });

    it('allows the type and the rate to change together', async () => {
      const { body } = await adminAgent
        .post('/api/counterparties')
        .send(supplier());
      track(body);

      const response = await adminAgent
        .patch(`/api/counterparties/${body.data.id}`)
        .send({ type: 'agent', commission_rate_bps: 1000 })
        .expect(200);

      expect(response.body.data.type).toBe('agent');
      expect(response.body.data.commission_rate_bps).toBe(1000);
    });

    it('404s for an unknown id', async () => {
      await adminAgent
        .patch('/api/counterparties/00000000-0000-0000-0000-0000000000aa')
        .send({ notes: 'x' })
        .expect(404);
    });
  });

  describe('DELETE /api/counterparties/:id', () => {
    it('deletes one with no accounting history', async () => {
      const { body } = await adminAgent
        .post('/api/counterparties')
        .send(supplier());

      const response = await adminAgent
        .delete(`/api/counterparties/${body.data.id}`)
        .expect(200);

      expect(response.body.deleted).toBe(true);

      await adminAgent.get(`/api/counterparties/${body.data.id}`).expect(404);
    });

    it('deactivates one that is referenced by an obligation', async () => {
      const { body } = await adminAgent
        .post('/api/counterparties')
        .send(supplier());
      track(body);

      // A payable against this supplier. obligations references
      // (tenant_id, counterparty_id) ON DELETE RESTRICT, so the row can no
      // longer be removed without orphaning the accounting.
      await db.insert(obligations).values({
        tenant_id: SEED_TENANT_ID,
        direction: 'payable',
        kind: 'full',
        counterparty_id: body.data.id,
        source_type: 'supplier_invoice',
        source_id: '00000000-0000-0000-0000-0000000000bb',
        amount_cents: 250000,
        currency: 'USD',
        status: 'open',
      });

      const response = await adminAgent
        .delete(`/api/counterparties/${body.data.id}`)
        .expect(200);

      expect(response.body.deleted).toBe(false);
      expect(response.body.data.is_active).toBe(false);

      // Still there, and still findable — deactivated, not removed.
      const after = await adminAgent
        .get(`/api/counterparties/${body.data.id}`)
        .expect(200);
      expect(after.body.data.is_active).toBe(false);
    });
  });
});
