// src/__tests__/integration/supplier-invoices.test.js
//
// The cost side's first real transaction. A supplier invoice is a document and
// a debt written together, so most of what is worth testing is that the two
// stay in step: the payable exists, carries the right amount, falls due on the
// supplier's terms, and reverses when the invoice is voided.

import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import app from '../../app.js';
import { db, initDatabase } from '#config/database.js';
import redis from '#config/redis.js';
import { supplierInvoices } from '#models/supplierInvoice.model.js';
import { bookings, tours } from '#models/schema.js';
import {
  counterparties,
  obligations,
  ledger_entries,
  fx_rates,
} from '#models/money.model.js';
import {
  createAuthenticatedAgent,
  createAuthenticatedAdminAgent,
  deleteTestUser,
  cleanupTestSession,
} from '../helpers/auth.helper.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';

describe('Supplier Invoice API Integration Tests', () => {
  let agent;
  let adminAgent;
  let testUser;
  let testAdmin;
  let sessionId;
  let adminSessionId;

  const madeInvoices = [];
  const madeCounterparties = [];

  const newSupplier = async (overrides = {}) => {
    const response = await adminAgent.post('/api/counterparties').send({
      type: 'supplier',
      name: `Mara Serena ${Date.now()}${Math.random()}`,
      default_currency: 'KES',
      payment_terms_days: 30,
      ...overrides,
    });
    madeCounterparties.push(response.body.data.id);
    return response.body.data;
  };

  const newInvoice = async (supplier, overrides = {}) => {
    const response = await adminAgent.post('/api/supplier-invoices').send({
      counterparty_id: supplier.id,
      invoice_number: `INV-${Date.now()}${Math.floor(Math.random() * 1000)}`,
      issued_on: '2026-11-01',
      amount: '1250.00',
      ...overrides,
    });
    if (response.body?.data?.id) madeInvoices.push(response.body.data.id);
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
    for (const invoiceId of madeInvoices) {
      const rows = await db
        .select({ id: obligations.id })
        .from(obligations)
        .where(
          and(
            eq(obligations.source_type, 'supplier_invoice'),
            eq(obligations.source_id, invoiceId)
          )
        );
      for (const { id } of rows) {
        await db.delete(ledger_entries).where(eq(ledger_entries.source_id, id));
        await db.delete(obligations).where(eq(obligations.id, id));
      }
      await db
        .delete(supplierInvoices)
        .where(eq(supplierInvoices.id, invoiceId));
    }
    madeInvoices.length = 0;

    for (const id of madeCounterparties) {
      await db.delete(counterparties).where(eq(counterparties.id, id));
    }
    madeCounterparties.length = 0;

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
      await request(app).get('/api/supplier-invoices').expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      const response = await agent.get('/api/supplier-invoices');
      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/supplier-invoices', () => {
    it('records the document and raises the payable together', async () => {
      const supplier = await newSupplier();
      const response = await newInvoice(supplier);

      expect(response.status).toBe(201);
      expect(response.body.data.amount).toBe('1250.00');
      expect(response.body.data.amount_cents).toBe(125000);
      expect(response.body.data.outstanding).toBe('1250.00');
      expect(response.body.data.obligation_id).toBeTruthy();

      // The payable is real, not just reported.
      const [obligation] = await db
        .select()
        .from(obligations)
        .where(eq(obligations.id, response.body.data.obligation_id));

      expect(obligation.direction).toBe('payable');
      expect(obligation.amount_cents).toBe(125000);
      expect(obligation.counterparty_id).toBe(supplier.id);
      expect(obligation.tenant_id).toBe(SEED_TENANT_ID);
    });

    it("falls due on the supplier's payment terms", async () => {
      const supplier = await newSupplier({ payment_terms_days: 30 });
      const response = await newInvoice(supplier, { issued_on: '2026-11-01' });

      // Net 30 from when they issued it, not from when it was entered.
      expect(response.body.data.due_on).toBe('2026-12-01');
    });

    it('lets an explicit due date override the terms', async () => {
      const supplier = await newSupplier({ payment_terms_days: 30 });
      const response = await newInvoice(supplier, {
        issued_on: '2026-11-01',
        due_on: '2026-11-10',
      });

      expect(response.body.data.due_on).toBe('2026-11-10');
    });

    it("uses the supplier's default currency when none is given", async () => {
      const supplier = await newSupplier({ default_currency: 'KES' });
      const response = await newInvoice(supplier);

      expect(response.body.data.currency).toBe('KES');
    });

    it('books the accrual against cost of sales', async () => {
      const supplier = await newSupplier();
      const response = await newInvoice(supplier);

      const legs = await db
        .select()
        .from(ledger_entries)
        .where(eq(ledger_entries.source_id, response.body.data.obligation_id));

      const accounts = legs.map((l) => l.account).sort();
      expect(accounts).toEqual(['accounts_payable', 'cost_of_sales']);
      // A payable credits AP and debits the cost, and the group balances.
      expect(legs.reduce((sum, l) => sum + l.base_amount_cents, 0)).toBe(0);
    });

    it('refuses a second invoice with the same number from one supplier', async () => {
      const supplier = await newSupplier();
      const invoice_number = `INV-DUP-${Date.now()}`;

      const first = await newInvoice(supplier, { invoice_number });
      expect(first.status).toBe(201);

      const second = await newInvoice(supplier, { invoice_number });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already sent an invoice/);
    });

    it('allows two suppliers to use the same number', async () => {
      const invoice_number = `INV-SHARED-${Date.now()}`;
      const a = await newSupplier();
      const b = await newSupplier();

      expect((await newInvoice(a, { invoice_number })).status).toBe(201);
      // Both numbering from 001 is ordinary and neither is wrong.
      expect((await newInvoice(b, { invoice_number })).status).toBe(201);
    });

    it('refuses a counterparty that is not a supplier', async () => {
      const agentParty = await newSupplier({
        type: 'agent',
        commission_rate_bps: 1000,
        payment_terms_days: null,
      });

      const response = await newInvoice(agentParty);
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/not a supplier/);
    });

    it('refuses a deactivated supplier', async () => {
      const supplier = await newSupplier();
      await adminAgent
        .patch(`/api/counterparties/${supplier.id}`)
        .send({ is_active: false })
        .expect(200);

      const response = await newInvoice(supplier);
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/deactivated/);
    });

    it('refuses an unknown supplier', async () => {
      const response = await adminAgent.post('/api/supplier-invoices').send({
        // A well-formed v4 UUID that exists nowhere. Zod v4's .uuid() checks
        // the RFC 4122 version nibble, so the all-zeros placeholders used
        // elsewhere in these suites are rejected as malformed before the
        // lookup is reached — a 400 rather than the 404 under test.
        counterparty_id: '11111111-1111-4111-8111-111111111111',
        invoice_number: 'INV-GHOST',
        issued_on: '2026-11-01',
        amount: '10.00',
      });

      expect(response.status).toBe(404);
    });

    it('refuses an amount larger than cents can hold exactly', async () => {
      const supplier = await newSupplier();

      // 90071992547409.93 is 9007199254740993 cents, one past what a JS
      // number holds exactly. It used to round to ...992 — a different amount
      // — and only be caught downstream by the money layer, so the caller got
      // an error about an amount they never sent.
      const response = await adminAgent.post('/api/supplier-invoices').send({
        counterparty_id: supplier.id,
        invoice_number: `INV-HUGE-${Date.now()}`,
        issued_on: '2026-11-01',
        amount: '90071992547409.93',
      });

      expect(response.status).toBe(400);
    });

    it('accepts the largest amount that is still exact', async () => {
      const supplier = await newSupplier();
      const response = await newInvoice(supplier, {
        amount: '90071992547409.91',
      });

      // 9007199254740991 cents is Number.MAX_SAFE_INTEGER — the boundary is
      // the last exact value, not a round number picked nearby.
      expect(response.status).toBe(201);
      expect(response.body.data.amount_cents).toBe(9007199254740991);
    });

    it('refuses an amount that is not a positive decimal', async () => {
      const supplier = await newSupplier();
      for (const amount of ['0', '-5.00', 'abc', '1.234']) {
        const response = await adminAgent.post('/api/supplier-invoices').send({
          counterparty_id: supplier.id,
          invoice_number: `INV-BAD-${Math.random()}`,
          issued_on: '2026-11-01',
          amount,
        });
        expect(response.status).toBe(400);
      }
    });

    it('leaves nothing behind when the payable cannot be raised', async () => {
      // A USD invoice with no rate loaded: createObligation refuses to invent
      // one. The invoice insert has already happened at that point, so this is
      // really a test that the two share a transaction.
      const supplier = await newSupplier({ default_currency: 'USD' });
      const invoice_number = `INV-NORATE-${Date.now()}`;

      await db.delete(fx_rates).where(eq(fx_rates.tenant_id, SEED_TENANT_ID));

      const response = await newInvoice(supplier, {
        invoice_number,
        currency: 'USD',
        issued_on: '2019-01-01',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);

      const rows = await db
        .select()
        .from(supplierInvoices)
        .where(eq(supplierInvoices.invoice_number, invoice_number));

      // Rolled back with the obligation, rather than left as a document with
      // no debt behind it.
      expect(rows).toHaveLength(0);
    });
  });

  describe('attributing a cost to a booking', () => {
    let tourId;
    let bookingId;

    beforeEach(async () => {
      const [tour] = await db
        .insert(tours)
        .values({
          tenant_id: SEED_TENANT_ID,
          title: 'Attribution Tour',
          slug: `attribution-tour-${Date.now()}${Math.random()}`,
          overview: 'Seeded for supplier invoice attribution.',
          duration: 5,
          price_amount: '1000.00',
          price_currency: 'KES',
          status: 'published',
        })
        .returning();
      tourId = tour.id;

      const [booking] = await db
        .insert(bookings)
        .values({
          tenant_id: SEED_TENANT_ID,
          booking_reference: `AT-${Date.now().toString(36)}`,
          tour_id: tourId,
          group_size: 2,
          start_date: new Date('2026-11-10'),
          end_date: new Date('2026-11-17'),
          price_per_person: '500.00',
          total_price: '1000.00',
          currency: 'KES',
          customer_name: 'Jane Traveller',
          customer_email: 'jane@example.com',
        })
        .returning();
      bookingId = booking.id;
    });

    afterEach(async () => {
      await db.delete(bookings).where(eq(bookings.tour_id, tourId));
      await db.delete(tours).where(eq(tours.id, tourId));
    });

    it('attributes an invoice to a booking', async () => {
      const supplier = await newSupplier();
      const response = await newInvoice(supplier, { booking_id: bookingId });

      expect(response.status).toBe(201);
      expect(response.body.data.booking_id).toBe(bookingId);
    });

    it('lets the booking be deleted, clearing only the attribution', async () => {
      const supplier = await newSupplier();
      const created = await newInvoice(supplier, { booking_id: bookingId });
      expect(created.status).toBe(201);

      // A plain ON DELETE SET NULL over the composite key nulls every column
      // in it, tenant_id included — and tenant_id is NOT NULL, so this delete
      // failed outright rather than clearing the attribution. The
      // column-scoped form says what was meant.
      await db.delete(bookings).where(eq(bookings.id, bookingId));

      const [invoice] = await db
        .select()
        .from(supplierInvoices)
        .where(eq(supplierInvoices.id, created.body.data.id));

      // The debt survives the booking; only the attribution goes.
      expect(invoice).toBeDefined();
      expect(invoice.booking_id).toBeNull();
      expect(invoice.tenant_id).toBe(SEED_TENANT_ID);
    });

    it('refuses a booking_id that resolves to nothing', async () => {
      const supplier = await newSupplier();
      const response = await newInvoice(supplier, {
        booking_id: '11111111-1111-4111-8111-111111111111',
      });

      // Checked in the service rather than left to the foreign key, which
      // would surface as an unmapped 23503 and a 500.
      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/Booking not found/);
    });
  });

  describe('GET /api/supplier-invoices', () => {
    it('reports outstanding from allocations rather than storing it', async () => {
      const supplier = await newSupplier();
      const created = await newInvoice(supplier, { amount: '1250.00' });

      const response = await adminAgent
        .get(`/api/supplier-invoices/${created.body.data.id}`)
        .expect(200);

      expect(response.body.data.outstanding).toBe('1250.00');
      expect(response.body.data.status).toBe('open');
      expect(response.body.data.supplier_name).toBe(supplier.name);
    });

    it('filters by supplier', async () => {
      const a = await newSupplier();
      const b = await newSupplier();
      await newInvoice(a);
      await newInvoice(b);

      const response = await adminAgent
        .get(`/api/supplier-invoices?counterparty_id=${a.id}`)
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      response.body.data.forEach((row) =>
        expect(row.counterparty_id).toBe(a.id)
      );
    });

    it('counts the same rows it returns when filtering on outstanding', async () => {
      const supplier = await newSupplier();
      await newInvoice(supplier);

      // The total is counted over the filtered query rather than the table, so
      // a page cannot report a total that includes rows the filter removed.
      const response = await adminAgent
        .get(
          `/api/supplier-invoices?status=open&counterparty_id=${supplier.id}`
        )
        .expect(200);

      expect(response.body.total).toBe(response.body.data.length);
      expect(response.body.data.every((r) => r.outstanding_cents > 0)).toBe(
        true
      );
    });

    it('answers 400 for a malformed id, not 500', async () => {
      // 'not-a-uuid' reaches a uuid column as a Postgres cast error, which the
      // error handler reads as a database failure — a server fault reported
      // for something the caller got wrong.
      const response = await adminAgent.get(
        '/api/supplier-invoices/not-a-uuid'
      );
      expect(response.status).toBe(400);
    });

    it('404s for an unknown invoice', async () => {
      await adminAgent
        // A well-formed v4 uuid: the route validates the shape before it
        // looks anything up, and zod v4 checks the RFC 4122 version nibble, so
        // an all-zeros placeholder is a 400 rather than the 404 under test.
        .get('/api/supplier-invoices/22222222-2222-4222-8222-222222222222')
        .expect(404);
    });
  });

  describe('POST /api/supplier-invoices/:id/void', () => {
    it('reverses the accrual and keeps the document', async () => {
      const supplier = await newSupplier();
      const created = await newInvoice(supplier, { amount: '900.00' });

      const response = await adminAgent
        .post(`/api/supplier-invoices/${created.body.data.id}/void`)
        .expect(200);

      expect(response.body.data.status).toBe('void');

      const legs = await db
        .select()
        .from(ledger_entries)
        .where(eq(ledger_entries.source_id, created.body.data.obligation_id));

      // Accrual plus its reversal: the cost nets to zero for an invoice that
      // turned out not to be owed.
      const cost = legs
        .filter((l) => l.account === 'cost_of_sales')
        .reduce((sum, l) => sum + l.base_amount_cents, 0);
      expect(cost).toBe(0);

      // The document survives — it was really sent, and why it was cancelled
      // is worth keeping.
      await adminAgent
        .get(`/api/supplier-invoices/${created.body.data.id}`)
        .expect(200);
    });
  });
});
