// src/__tests__/integration/fx-rates.test.js
//
// The second writer the money layer never had. Until this endpoint existed,
// toBaseCents refused to convert anything priced outside the tenant's base
// currency — correctly, since inventing a rate is worse than failing — so a
// USD lodge invoice could not be recorded at all.

import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { fx_rates, ledger_entries, obligations } from '#models/money.model.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

describe('FX Rate API Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;
  const created = [];

  // Dates are pushed far out so these never collide with a rate another suite
  // loaded — the unique constraint is per (tenant, pair, day).
  let dayCounter = 0;
  const nextDate = () => {
    dayCounter += 1;
    return `2031-03-${String(dayCounter).padStart(2, '0')}`;
  };

  const rateBody = (overrides = {}) => ({
    base_currency: 'USD',
    quote_currency: 'KES',
    rate: '130.25',
    as_of: nextDate(),
    source: 'test',
    ...overrides,
  });

  const load = async (overrides = {}) => {
    const response = await adminAgent
      .post('/api/fx-rates')
      .send(rateBody(overrides));
    if (response.body?.data?.id) created.push(response.body.data.id);
    return response;
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
    if (created.length) {
      await db
        .delete(ledger_entries)
        .where(inArray(ledger_entries.fx_rate_id, created));
      await db.delete(fx_rates).where(inArray(fx_rates.id, created));
      created.length = 0;
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
      await request(app).get('/api/fx-rates').expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      const response = await agent.get('/api/fx-rates');
      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/fx-rates', () => {
    it('stores a decimal rate as exact parts per million', async () => {
      const response = await load({ rate: '130.25' });
      expect(response.status).toBe(201);

      // 130.25 exactly, not 130.24999999999999 via a float multiply.
      expect(response.body.data.rate_ppm).toBe(130250000);
      expect(response.body.data.rate).toBe('130.25');
      expect(response.body.data.tenant_id).toBe(SEED_TENANT_ID);
      expect(response.body.data.is_shared).toBe(false);
    });

    it('rounds at the seventh decimal rather than truncating', async () => {
      const response = await load({ rate: '130.2500005' });
      expect(response.body.data.rate_ppm).toBe(130250001);
    });

    it('refuses a rate that is not a positive decimal', async () => {
      for (const rate of ['-1', 'abc', '', '1.2.3']) {
        const response = await adminAgent
          .post('/api/fx-rates')
          .send(rateBody({ rate }));
        expect(response.status).toBe(400);
      }
    });

    it('refuses a rate of zero', async () => {
      const response = await adminAgent
        .post('/api/fx-rates')
        .send(rateBody({ rate: '0' }));
      expect(response.status).toBe(400);
    });

    it('refuses a date the calendar does not have', async () => {
      // Date.parse rolls 2025-02-30 forward to 2025-03-02, so without a
      // round-trip check the rate is filed under a day nobody chose.
      for (const as_of of ['2025-02-30', '2025-13-01', '2025-00-10']) {
        const response = await adminAgent
          .post('/api/fx-rates')
          .send(rateBody({ as_of }));
        expect(response.status).toBe(400);
      }
    });

    it('refuses identical base and quote currencies', async () => {
      const response = await adminAgent
        .post('/api/fx-rates')
        .send(rateBody({ base_currency: 'KES', quote_currency: 'KES' }));

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.details)).toMatch(/must differ/);
    });

    it('refuses a second rate for the same pair and day', async () => {
      const as_of = nextDate();
      const first = await load({ as_of });
      expect(first.status).toBe(201);

      const second = await adminAgent
        .post('/api/fx-rates')
        .send(rateBody({ as_of, rate: '131.00' }));

      // Without the unique constraint both rows would exist and findRate's
      // ordering would have no tiebreaker between them.
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already exists/);
    });

    it('never creates a shared rate, whatever the caller sends', async () => {
      const response = await load({ tenant_id: null });
      expect(response.body.data.tenant_id).toBe(SEED_TENANT_ID);
      expect(response.body.data.is_shared).toBe(false);
    });
  });

  describe('GET /api/fx-rates/resolve', () => {
    it('answers with the rate a conversion would actually use', async () => {
      const older = await load({ as_of: '2031-03-20', rate: '128.00' });
      const newer = await load({ as_of: '2031-03-22', rate: '131.00' });
      expect(older.status).toBe(201);
      expect(newer.status).toBe(201);

      // Most recent on or before the date — the 22nd is in the future here, so
      // the 20th is the answer.
      const onThe21st = await adminAgent
        .get(
          '/api/fx-rates/resolve?base_currency=USD&quote_currency=KES&on_date=2031-03-21'
        )
        .expect(200);
      expect(onThe21st.body.data.rate).toBe('128');

      const onThe23rd = await adminAgent
        .get(
          '/api/fx-rates/resolve?base_currency=USD&quote_currency=KES&on_date=2031-03-23'
        )
        .expect(200);
      expect(onThe23rd.body.data.rate).toBe('131');
    });

    it('404s when no rate is loaded on or before the date', async () => {
      await adminAgent
        .get(
          '/api/fx-rates/resolve?base_currency=USD&quote_currency=KES&on_date=2019-01-01'
        )
        .expect(404);
    });

    it('is not swallowed by the :id route', async () => {
      // 'resolve' must not be read as an id and answered 404-for-missing-rate
      // with a different shape; a bad query here is a 400, not a cast error.
      const response = await adminAgent.get('/api/fx-rates/resolve');
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/fx-rates', () => {
    it('filters by currency pair', async () => {
      await load();
      const response = await adminAgent
        .get('/api/fx-rates?base_currency=USD&quote_currency=KES')
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      response.body.data.forEach((row) => {
        expect(row.base_currency).toBe('USD');
        expect(row.quote_currency).toBe('KES');
      });
    });

    it('returns the rate as a decimal string alongside the integer', async () => {
      await load({ rate: '129.45' });
      const response = await adminAgent
        .get('/api/fx-rates?scope=own')
        .expect(200);

      const row = response.body.data.find((r) => r.rate_ppm === 129450000);
      expect(row.rate).toBe('129.45');
    });
  });

  describe('DELETE /api/fx-rates/:id', () => {
    it('deletes a rate nothing has been converted at', async () => {
      const { body } = await load();
      await adminAgent.delete(`/api/fx-rates/${body.data.id}`).expect(200);
      await adminAgent.get(`/api/fx-rates/${body.data.id}`).expect(404);
    });

    it('refuses to delete a rate a ledger entry references', async () => {
      const { body } = await load();

      // ledger_entries.fx_rate_id is ON DELETE SET NULL, so without the guard
      // this delete would succeed and quietly erase which rate the entry used.
      await db.insert(ledger_entries).values({
        tenant_id: SEED_TENANT_ID,
        entry_group_id: '00000000-0000-0000-0000-0000000000e1',
        account: 'accounts_receivable',
        amount_cents: 100000,
        currency: 'USD',
        base_amount_cents: 13025000,
        fx_rate_id: body.data.id,
      });

      const response = await adminAgent
        .delete(`/api/fx-rates/${body.data.id}`)
        .expect(409);
      expect(response.body.error).toMatch(/referenced by ledger entries/);

      // Still there, and still explaining the entry that points at it.
      await adminAgent.get(`/api/fx-rates/${body.data.id}`).expect(200);
    });

    it('refuses to delete a rate an obligation was accrued at', async () => {
      const { body } = await load();

      // An obligation with an accrual rate and no ledger entry referencing it.
      // createObligation always writes both together, so the ledger check
      // above already covers every case the API can produce -- but that is an
      // implicit coupling, and obligations.fx_rate_id is ON DELETE SET NULL.
      // Nulling it would send allocate back to the settlement-rate fallback,
      // which is the receivable residue that storing the accrual rate exists
      // to prevent.
      const [obligation] = await db
        .insert(obligations)
        .values({
          tenant_id: SEED_TENANT_ID,
          direction: 'receivable',
          kind: 'full',
          source_type: 'booking',
          source_id: '00000000-0000-0000-0000-0000000000d1',
          amount_cents: 100000,
          currency: 'USD',
          status: 'open',
          fx_rate_id: body.data.id,
        })
        .returning();

      try {
        const response = await adminAgent
          .delete(`/api/fx-rates/${body.data.id}`)
          .expect(409);
        expect(response.body.error).toMatch(/referenced by ledger entries/);

        // Still there, and the obligation still knows what it was accrued at.
        const [stillSet] = await db
          .select()
          .from(obligations)
          .where(eq(obligations.id, obligation.id));
        expect(stillSet.fx_rate_id).toBe(body.data.id);
      } finally {
        await db.delete(obligations).where(eq(obligations.id, obligation.id));
      }
    });

    it('404s for an unknown id', async () => {
      await adminAgent
        .delete('/api/fx-rates/00000000-0000-0000-0000-0000000000cc')
        .expect(404);
    });
  });

  describe('the shared reference rates', () => {
    it('cannot be removed by a tenant', async () => {
      const [shared] = await db
        .insert(fx_rates)
        .values({
          tenant_id: null,
          base_currency: 'USD',
          quote_currency: 'KES',
          rate_ppm: 127000000,
          as_of: '2031-04-09',
          source: 'shared-test',
        })
        .returning();

      try {
        // Readable — findRate falls back to it — but 0018's policies make it
        // invisible to DELETE, so from the tenant's side it is not theirs.
        await adminAgent.get(`/api/fx-rates/${shared.id}`).expect(200);
        await adminAgent.delete(`/api/fx-rates/${shared.id}`).expect(404);

        const [stillThere] = await db
          .select()
          .from(fx_rates)
          .where(eq(fx_rates.id, shared.id));
        expect(stillThere).toBeDefined();
      } finally {
        await db.delete(fx_rates).where(eq(fx_rates.id, shared.id));
      }
    });
  });
});
