// src/__tests__/integration/obligations.test.js
//
// The lookup the unmatched worklist needs to offer candidates.
//
// /settlements/:id/allocations has always taken an obligation_id, and nothing
// could tell you which ids existed. /counterparties/:id/payables enumerated
// them only where there was a counterparty — so money going OUT to a supplier
// could be matched and money coming IN could not, because a booking receivable
// carries no counterparty at all. That is the half of the worklist that fills
// up, so these lean on it.

import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';

import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { runWithTenant } from '#config/tenantContext.js';
import { counterparties, obligations } from '#models/money.model.js';
import * as money from '#services/money.service.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

const asTenant = (fn) => runWithTenant(SEED_TENANT_ID, fn);

describe('Open obligations lookup', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;

  const madeObligations = [];
  const madeCounterparties = [];

  const raise = async (overrides = {}) => {
    const obligation = await asTenant(() =>
      money.createObligation({
        direction: 'receivable',
        kind: 'full',
        sourceType: 'booking',
        sourceId: crypto.randomUUID(),
        amountCents: 50000,
        currency: 'KES',
        description: `Lookup test ${Date.now()}${Math.random()}`,
        ...overrides,
      })
    );
    madeObligations.push(obligation.id);
    return obligation;
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
    if (madeObligations.length) {
      await db
        .delete(obligations)
        .where(inArray(obligations.id, madeObligations));
      madeObligations.length = 0;
    }
    if (madeCounterparties.length) {
      await db
        .delete(counterparties)
        .where(inArray(counterparties.id, madeCounterparties));
      madeCounterparties.length = 0;
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
      await request(app).get('/api/obligations').expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      await agent.get('/api/obligations').expect(403);
    });
  });

  it('returns a booking receivable, which has no counterparty', async () => {
    // The case the whole endpoint exists for: payables could never list this,
    // because it filters on a counterparty_id that a booking never sets.
    const obligation = await raise();

    const response = await adminAgent
      .get('/api/obligations?direction=receivable')
      .expect(200);

    const found = response.body.data.find((row) => row.id === obligation.id);
    expect(found).toBeDefined();
    expect(found.counterparty_id).toBeNull();
    expect(found.outstanding).toBe('500.00');
    expect(found.outstanding_cents).toBe(50000);
  });

  it('leaves out anything already settled', async () => {
    const obligation = await raise();

    const settlement = await asTenant(() =>
      money.recordSettlement({
        direction: 'in',
        method: 'mpesa',
        amountCents: 50000,
        currency: 'KES',
        externalReference: `FULL-${Date.now()}${Math.random()}`,
      })
    );
    await asTenant(() =>
      money.allocate({
        settlementId: settlement.id,
        obligationId: obligation.id,
        amountCents: 50000,
      })
    );

    // status is still 'open' — allocate never touches it, by design. An
    // endpoint reading status alone would keep offering this as a candidate
    // for money it can no longer take.
    const response = await adminAgent
      .get('/api/obligations?direction=receivable')
      .expect(200);

    expect(response.body.data.some((row) => row.id === obligation.id)).toBe(
      false
    );

    await db.delete(obligations).where(eq(obligations.id, obligation.id));
    madeObligations.splice(madeObligations.indexOf(obligation.id), 1);
  });

  it('separates the two directions', async () => {
    const receivable = await raise();

    const response = await adminAgent
      .get('/api/obligations?direction=payable')
      .expect(200);

    // Money out can only clear a payable. Offering a receivable as a candidate
    // is offering a 422 from the allocation.
    expect(response.body.data.some((row) => row.id === receivable.id)).toBe(
      false
    );
  });

  it('filters by currency, because a settlement can only clear its own', async () => {
    const kes = await raise({ currency: 'KES' });

    const response = await adminAgent
      .get('/api/obligations?direction=receivable&currency=USD')
      .expect(200);

    expect(response.body.data.some((row) => row.id === kes.id)).toBe(false);
  });

  it('counts only what it would list', async () => {
    await raise();

    const response = await adminAgent
      .get('/api/obligations?direction=receivable&limit=1')
      .expect(200);

    // A plain count over obligations would include settled ones and promise
    // more pages than the list can fill.
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.data.length).toBeLessThanOrEqual(1);
    expect(response.body.total).toBeGreaterThanOrEqual(response.body.count);
  });
});
