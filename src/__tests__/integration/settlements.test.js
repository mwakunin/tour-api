// src/__tests__/integration/settlements.test.js
//
// The unmatched receipts worklist, and clearing it.
//
// money.service has said since the money layer landed that unmatched money
// "stays unallocated and shows on the unmatched receipts worklist rather than
// being forced somewhere". There was no worklist until now, so the interesting
// tests are that money with nowhere to go appears on it, that matching it by
// hand moves the ledger, and that it drops off once there is nothing left.

import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { runWithTenant } from '#config/tenantContext.js';
import {
  counterparties,
  obligations,
  settlements,
  allocations,
  ledger_entries,
} from '#models/money.model.js';
import { supplierInvoices } from '#models/supplierInvoice.model.js';
import * as money from '#services/money.service.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

const asTenant = (fn) => runWithTenant(SEED_TENANT_ID, fn);

describe('Settlement worklist Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;

  const madeCounterparties = [];
  const madeSettlements = [];

  const newSupplier = async (overrides = {}) => {
    const response = await adminAgent.post('/api/counterparties').send({
      type: 'supplier',
      name: `Mara Lodge ${Date.now()}${Math.random()}`,
      default_currency: 'KES',
      payment_terms_days: 30,
      ...overrides,
    });
    madeCounterparties.push(response.body.data.id);
    return response.body.data;
  };

  const newInvoice = (supplier, amount, issued_on = '2026-01-01') =>
    adminAgent.post('/api/supplier-invoices').send({
      counterparty_id: supplier.id,
      invoice_number: `INV-${Date.now()}${Math.floor(Math.random() * 10000)}`,
      issued_on,
      amount,
    });

  // Money that moved with nothing raised for it yet — a bank transfer that
  // arrived before the invoice was entered.
  const strandedPayment = async (counterpartyId, amountCents) => {
    const settlement = await asTenant(() =>
      money.recordSettlement({
        direction: 'out',
        counterpartyId,
        method: 'bank_transfer',
        amountCents,
        currency: 'KES',
        externalReference: `SLIP-${Date.now()}${Math.random()}`,
      })
    );
    madeSettlements.push(settlement.id);
    return settlement;
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
    const obs = madeCounterparties.length
      ? await db
          .select({ id: obligations.id })
          .from(obligations)
          .where(inArray(obligations.counterparty_id, madeCounterparties))
      : [];
    const obIds = obs.map((o) => o.id);

    if (madeSettlements.length) {
      await db
        .delete(allocations)
        .where(inArray(allocations.settlement_id, madeSettlements));
    }
    if (obIds.length) {
      await db
        .delete(allocations)
        .where(inArray(allocations.obligation_id, obIds));
      await db
        .delete(ledger_entries)
        .where(inArray(ledger_entries.source_id, obIds));
    }
    if (madeSettlements.length) {
      await db
        .delete(settlements)
        .where(inArray(settlements.id, madeSettlements));
      madeSettlements.length = 0;
    }
    if (madeCounterparties.length) {
      await db
        .delete(settlements)
        .where(inArray(settlements.counterparty_id, madeCounterparties));
      await db
        .delete(supplierInvoices)
        .where(inArray(supplierInvoices.counterparty_id, madeCounterparties));
      if (obIds.length) {
        await db.delete(obligations).where(inArray(obligations.id, obIds));
      }
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
      await request(app).get('/api/settlements/unmatched').expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      const response = await agent.get('/api/settlements/unmatched');
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/settlements/unmatched', () => {
    it('shows money that has moved with nowhere to go', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);

      const response = await adminAgent
        .get(`/api/settlements/unmatched?counterparty_id=${supplier.id}`)
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        settlement_id: settlement.id,
        unallocated: '500.00',
        amount: '500.00',
        counterparty_name: supplier.name,
      });
    });

    it('drops a settlement off once it is fully spent', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '500.00');

      // Paid through the endpoint, which allocates as it goes.
      await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '500.00', method: 'bank_transfer' })
        .expect(201);

      const response = await adminAgent
        .get(`/api/settlements/unmatched?counterparty_id=${supplier.id}`)
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });

    it('still shows the remainder of a partly spent settlement', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '200.00');

      await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '500.00', method: 'bank_transfer' })
        .expect(201);

      const response = await adminAgent
        .get(`/api/settlements/unmatched?counterparty_id=${supplier.id}`)
        .expect(200);

      // 200 of the 500 found an invoice; the rest is still looking for one.
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].unallocated).toBe('300.00');
    });

    it('filters by direction', async () => {
      const supplier = await newSupplier();
      await strandedPayment(supplier.id, 50000);

      const outbound = await adminAgent
        .get(
          `/api/settlements/unmatched?direction=out&counterparty_id=${supplier.id}`
        )
        .expect(200);
      expect(outbound.body.data).toHaveLength(1);

      const inbound = await adminAgent
        .get(
          `/api/settlements/unmatched?direction=in&counterparty_id=${supplier.id}`
        )
        .expect(200);
      expect(inbound.body.data).toHaveLength(0);
    });

    it('counts the same rows it returns', async () => {
      const supplier = await newSupplier();
      await strandedPayment(supplier.id, 50000);

      const response = await adminAgent
        .get(`/api/settlements/unmatched?counterparty_id=${supplier.id}`)
        .expect(200);

      // The total is counted over the filtered query, so it cannot include
      // rows the HAVING clause removed.
      expect(response.body.total).toBe(response.body.data.length);
    });

    it('does not keep the figures in a cache', async () => {
      const response = await adminAgent
        .get('/api/settlements/unmatched')
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('POST /api/settlements/:id/allocations', () => {
    it('matches stranded money to an invoice raised later', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);

      // The invoice turns up after the payment, which is the whole reason the
      // worklist exists.
      const invoice = await newInvoice(supplier, '500.00');

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: invoice.body.data.obligation_id })
        .expect(201);

      // No amount given, so as much as both sides could take.
      expect(response.body.data.matched).toBe('500.00');
      expect(response.body.data.settlement.unallocated).toBe('0.00');

      const after = await adminAgent
        .get(`/api/settlements/unmatched?counterparty_id=${supplier.id}`)
        .expect(200);
      expect(after.body.data).toHaveLength(0);
    });

    it('matches a partial amount when asked', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);
      const invoice = await newInvoice(supplier, '500.00');

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({
          obligation_id: invoice.body.data.obligation_id,
          amount: '200.00',
        })
        .expect(201);

      expect(response.body.data.matched).toBe('200.00');
      expect(response.body.data.settlement.unallocated).toBe('300.00');
    });

    it('moves the ledger, not just the allocation table', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);
      const invoice = await newInvoice(supplier, '500.00');
      const obligationId = invoice.body.data.obligation_id;

      await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: obligationId })
        .expect(201);

      const allocated = await db
        .select({ id: allocations.id })
        .from(allocations)
        .where(eq(allocations.obligation_id, obligationId));

      const legs = await db
        .select()
        .from(ledger_entries)
        .where(
          inArray(ledger_entries.source_id, [
            obligationId,
            ...allocated.map((a) => a.id),
          ])
        );

      // Accrued and then cleared: the payable nets to zero.
      const payable = legs
        .filter((l) => l.account === 'accounts_payable')
        .reduce((sum, l) => sum + l.base_amount_cents, 0);
      expect(payable).toBe(0);
    });

    it("refuses to clear another supplier's invoice", async () => {
      const paid = await newSupplier();
      const other = await newSupplier();

      const settlement = await strandedPayment(paid.id, 50000);
      const theirInvoice = await newInvoice(other, '500.00');

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: theirInvoice.body.data.obligation_id });

      // allocate checks status, currency, direction and both balances, and
      // none of those catch this: the ledger would balance while one
      // supplier's payment cleared another's debt.
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/different counterparties/);
    });

    it('returns the counterparty name it promises', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);
      const invoice = await newInvoice(supplier, '500.00');

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: invoice.body.data.obligation_id })
        .expect(201);

      // The shape includes counterparty_name, and this query has to join for
      // it — the list endpoint did and this one did not, so the same field was
      // populated in one response and null in the other.
      expect(response.body.data.settlement.counterparty_name).toBe(
        supplier.name
      );
    });

    it('refuses an obligation in the wrong direction', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);

      // A receivable cannot be settled by money going out.
      const receivable = await asTenant(() =>
        money.createObligation({
          direction: 'receivable',
          kind: 'full',
          sourceType: 'booking',
          sourceId: '33333333-3333-4333-8333-333333333333',
          amountCents: 50000,
          currency: 'KES',
          dueOn: '2026-01-31',
        })
      );

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: receivable.id });

      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/direction mismatch/);

      await db
        .delete(ledger_entries)
        .where(eq(ledger_entries.source_id, receivable.id));
      await db.delete(obligations).where(eq(obligations.id, receivable.id));
    });

    it('refuses to over-allocate the obligation', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);
      const invoice = await newInvoice(supplier, '200.00');

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({
          obligation_id: invoice.body.data.obligation_id,
          amount: '400.00',
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/over-allocating/);
    });

    it('409s once the settlement has nothing left', async () => {
      const supplier = await newSupplier();
      const settlement = await strandedPayment(supplier.id, 50000);
      const first = await newInvoice(supplier, '500.00');
      const second = await newInvoice(supplier, '100.00', '2026-02-01');

      await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: first.body.data.obligation_id })
        .expect(201);

      const response = await adminAgent
        .post(`/api/settlements/${settlement.id}/allocations`)
        .send({ obligation_id: second.body.data.obligation_id });

      // Both rows exist; the match is simply no longer possible.
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/nothing left to allocate/);
    });

    it('404s for a settlement that does not exist', async () => {
      const supplier = await newSupplier();
      const invoice = await newInvoice(supplier, '500.00');

      await adminAgent
        .post(
          '/api/settlements/44444444-4444-4444-8444-444444444444/allocations'
        )
        .send({ obligation_id: invoice.body.data.obligation_id })
        .expect(404);
    });

    it('400s for a malformed settlement id', async () => {
      const response = await adminAgent
        .post('/api/settlements/not-a-uuid/allocations')
        .send({ obligation_id: '44444444-4444-4444-8444-444444444444' });
      expect(response.status).toBe(400);
    });
  });
});
