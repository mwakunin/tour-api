// src/__tests__/integration/payables.test.js
//
// Paying the cost side. Until this endpoint existed the operator could accrue
// a lodge invoice or an agent's commission and never record settling it, so
// every payable stayed outstanding forever.
//
// A payment is addressed to a counterparty, not an invoice: an operator pays a
// lodge a lump sum and expects it to clear what has been owed longest. Most of
// what is worth testing is that ordering, and that the money and the ledger
// agree afterwards.

import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import {
  counterparties,
  obligations,
  settlements,
  allocations,
  ledger_entries,
} from '#models/money.model.js';
import { supplierInvoices } from '#models/supplierInvoice.model.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';

describe('Payables API Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;

  const madeCounterparties = [];

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

  const newInvoice = (supplier, amount, issued_on) =>
    adminAgent.post('/api/supplier-invoices').send({
      counterparty_id: supplier.id,
      invoice_number: `INV-${Date.now()}${Math.floor(Math.random() * 10000)}`,
      issued_on,
      amount,
    });

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
    if (madeCounterparties.length) {
      const obs = await db
        .select({ id: obligations.id })
        .from(obligations)
        .where(inArray(obligations.counterparty_id, madeCounterparties));
      const obIds = obs.map((o) => o.id);

      if (obIds.length) {
        await db
          .delete(allocations)
          .where(inArray(allocations.obligation_id, obIds));
      }
      await db
        .delete(settlements)
        .where(inArray(settlements.counterparty_id, madeCounterparties));
      await db
        .delete(supplierInvoices)
        .where(inArray(supplierInvoices.counterparty_id, madeCounterparties));
      if (obIds.length) {
        await db
          .delete(ledger_entries)
          .where(inArray(ledger_entries.source_id, obIds));
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
      const supplier = { id: '11111111-1111-4111-8111-111111111111' };
      await request(app)
        .get(`/api/counterparties/${supplier.id}/payables`)
        .expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      const supplier = await newSupplier();
      const response = await agent.get(
        `/api/counterparties/${supplier.id}/payables`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/counterparties/:id/payables', () => {
    it('lists what is owed, oldest due first', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '900.00', '2026-03-01'); // due 2026-03-31
      await newInvoice(supplier, '500.00', '2026-01-01'); // due 2026-01-31

      const response = await adminAgent
        .get(`/api/counterparties/${supplier.id}/payables`)
        .expect(200);

      expect(response.body.data.payables).toHaveLength(2);
      // Oldest due first, which is the order a payment will clear them in.
      expect(response.body.data.payables[0].due_on).toBe('2026-01-31');
      expect(response.body.data.payables[1].due_on).toBe('2026-03-31');
    });

    it('totals by currency rather than into one figure', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '900.00', '2026-03-01');

      const response = await adminAgent
        .get(`/api/counterparties/${supplier.id}/payables`)
        .expect(200);

      const totals = response.body.data.outstanding_by_currency;
      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({
        currency: 'KES',
        outstanding: '900.00',
      });
    });

    it('does not keep the figures in a cache', async () => {
      const supplier = await newSupplier();
      const response = await adminAgent
        .get(`/api/counterparties/${supplier.id}/payables`)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('404s for a counterparty that does not exist', async () => {
      await adminAgent
        .get(
          '/api/counterparties/11111111-1111-4111-8111-111111111111/payables'
        )
        .expect(404);
    });
  });

  describe('POST /api/counterparties/:id/payments', () => {
    it('clears the oldest invoice first', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '900.00', '2026-03-01'); // due 2026-03-31
      await newInvoice(supplier, '500.00', '2026-01-01'); // due 2026-01-31

      // Enough for the older invoice and part of the newer one.
      const response = await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '700.00', method: 'bank_transfer' })
        .expect(201);

      expect(response.body.data.allocated).toBe('700.00');
      expect(response.body.data.unallocated).toBe('0.00');
      expect(response.body.data.cleared).toHaveLength(2);

      const after = await adminAgent
        .get(`/api/counterparties/${supplier.id}/payables`)
        .expect(200);

      // The January invoice is gone from the list; 200 of March's is left.
      expect(after.body.data.payables).toHaveLength(1);
      expect(after.body.data.payables[0].outstanding).toBe('700.00');
    });

    it('settles an invoice completely and drops it off the list', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '500.00', '2026-01-01');

      await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '500.00', method: 'mpesa' })
        .expect(201);

      const after = await adminAgent
        .get(`/api/counterparties/${supplier.id}/payables`)
        .expect(200);

      // Still an open obligation in the ledger, with nothing left on it — a
      // list of what to pay is not a list of what exists.
      expect(after.body.data.payables).toHaveLength(0);
      expect(after.body.data.outstanding_by_currency).toHaveLength(0);
    });

    it('keeps an overpayment on the settlement rather than forcing it', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '500.00', '2026-01-01');

      const response = await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '800.00', method: 'bank_transfer' })
        .expect(201);

      // Paying a lodge ahead of their next invoice is ordinary. The balance
      // waits on the settlement instead of being pushed somewhere it does not
      // belong.
      expect(response.body.data.allocated).toBe('500.00');
      expect(response.body.data.unallocated).toBe('300.00');
    });

    it('books the payment through the ledger', async () => {
      const supplier = await newSupplier();
      const invoice = await newInvoice(supplier, '500.00', '2026-01-01');

      await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '500.00', method: 'bank_transfer' })
        .expect(201);

      const obligationId = invoice.body.data.obligation_id;

      // The accrual group is filed under the obligation; the clearing group is
      // filed under the allocation. Both touch accounts_payable, and only
      // together do they net — a filter on the obligation alone sees the debt
      // and not the payment.
      const allocated = await db
        .select({ id: allocations.id })
        .from(allocations)
        .where(eq(allocations.obligation_id, obligationId));

      const sources = [obligationId, ...allocated.map((a) => a.id)];

      const legs = await db
        .select()
        .from(ledger_entries)
        .where(inArray(ledger_entries.source_id, sources));

      const payable = legs
        .filter((l) => l.account === 'accounts_payable')
        .reduce((sum, l) => sum + l.base_amount_cents, 0);

      // Accrued and then paid: the payable nets to zero.
      expect(payable).toBe(0);

      // And the money left by the rail it was paid on.
      const cash = legs
        .filter((l) => l.account === 'cash_bank')
        .reduce((sum, l) => sum + l.base_amount_cents, 0);
      expect(cash).toBe(-50000);
    });

    it('refuses a payment to somebody owed nothing', async () => {
      const supplier = await newSupplier();

      const response = await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '100.00', method: 'mpesa' });

      // Almost always a mistyped counterparty. Recording it would leave money
      // unmatched for somebody to chase later.
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/nothing outstanding/);
    });

    it('refuses a currency the counterparty is not owed in', async () => {
      const supplier = await newSupplier({ default_currency: 'KES' });
      await newInvoice(supplier, '500.00', '2026-01-01');

      const response = await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '100.00', method: 'bank_transfer', currency: 'USD' });

      expect(response.status).toBe(422);
    });

    it('refuses an amount that is not a positive decimal', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '500.00', '2026-01-01');

      for (const amount of ['0', '-5.00', 'abc']) {
        const response = await adminAgent
          .post(`/api/counterparties/${supplier.id}/payments`)
          .send({ amount, method: 'mpesa' });
        expect(response.status).toBe(400);
      }
    });

    it('refuses an unknown payment method', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier, '500.00', '2026-01-01');

      const response = await adminAgent
        .post(`/api/counterparties/${supplier.id}/payments`)
        .send({ amount: '100.00', method: 'carrier-pigeon' });

      expect(response.status).toBe(400);
    });

    it('answers 400 for a malformed counterparty id', async () => {
      const response = await adminAgent
        .post('/api/counterparties/not-a-uuid/payments')
        .send({ amount: '100.00', method: 'mpesa' });

      expect(response.status).toBe(400);
    });
  });
});
