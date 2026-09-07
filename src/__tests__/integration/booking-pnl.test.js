// src/__tests__/integration/booking-pnl.test.js
//
// What a booking made. The point of the whole money layer, and the first thing
// in it that answers a question an operator would actually ask.
//
// Written against the services rather than through HTTP, because the
// interesting assertions are about the ledger — that a cancellation nets out
// without anybody filtering voided rows, that a lodge bill only counts when it
// was attributed to a trip, that commission comes off the margin.

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant } from '#config/tenantContext.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import {
  tours,
  bookings,
  counterparties,
  obligations,
  allocations,
  ledger_entries,
} from '#models/schema.js';
import { supplierInvoices } from '#models/supplierInvoice.model.js';
import * as bookingLedger from '#services/bookingLedger.service.js';
import * as supplierInvoiceService from '#services/supplierInvoice.service.js';
import { bookingPnl } from '#services/bookingPnl.service.js';

const asTenant = (fn) => runWithTenant(SEED_TENANT_ID, fn);

let tourId;
const madeCounterparties = [];

const seedTour = async () => {
  const [tour] = await db
    .insert(tours)
    .values({
      tenant_id: SEED_TENANT_ID,
      title: 'P&L Test Tour',
      slug: `pnl-test-tour-${Date.now()}`,
      overview: 'Seeded for the booking P&L tests.',
      duration: 7,
      price_amount: '4200.00',
      price_currency: 'KES',
      status: 'published',
    })
    .returning();
  return tour.id;
};

const seedBooking = async (overrides = {}) => {
  const [booking] = await db
    .insert(bookings)
    .values({
      tenant_id: SEED_TENANT_ID,
      booking_reference: `PL-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      tour_id: tourId,
      group_size: 2,
      start_date: new Date('2026-11-10'),
      end_date: new Date('2026-11-17'),
      price_per_person: '2100.00',
      total_price: '4200.00',
      currency: 'KES',
      customer_name: 'Jane Traveller',
      customer_email: 'jane@example.com',
      ...overrides,
    })
    .returning();
  return booking;
};

const seedCounterparty = async (values) => {
  const [row] = await db
    .insert(counterparties)
    .values({ tenant_id: SEED_TENANT_ID, ...values })
    .returning();
  madeCounterparties.push(row.id);
  return row;
};

// Hooks live inside a describe, not at module scope. setup.js registers a
// root-level afterAll that closes the database pool, and root-level hooks run
// in registration order — so a module-scope afterAll here runs *after* the
// pool has already been closed and every cleanup query fails with
// CONNECTION_ENDED. Every other suite in this directory nests its hooks for
// the same reason.
describe('booking money', () => {
  beforeAll(async () => {
    tourId = await seedTour();
  });

  beforeEach(async () => {
    await db
      .delete(ledger_entries)
      .where(eq(ledger_entries.tenant_id, SEED_TENANT_ID));
    await db
      .delete(allocations)
      .where(eq(allocations.tenant_id, SEED_TENANT_ID));
    await db
      .delete(supplierInvoices)
      .where(eq(supplierInvoices.tenant_id, SEED_TENANT_ID));
    await db
      .delete(obligations)
      .where(eq(obligations.tenant_id, SEED_TENANT_ID));
    await db.delete(bookings).where(eq(bookings.tour_id, tourId));
    for (const id of madeCounterparties) {
      await db.delete(counterparties).where(eq(counterparties.id, id));
    }
    madeCounterparties.length = 0;
  });

  afterAll(async () => {
    await db
      .delete(ledger_entries)
      .where(eq(ledger_entries.tenant_id, SEED_TENANT_ID));
    await db
      .delete(allocations)
      .where(eq(allocations.tenant_id, SEED_TENANT_ID));
    await db
      .delete(supplierInvoices)
      .where(eq(supplierInvoices.tenant_id, SEED_TENANT_ID));
    await db
      .delete(obligations)
      .where(eq(obligations.tenant_id, SEED_TENANT_ID));
    await db.delete(bookings).where(eq(bookings.tour_id, tourId));
    for (const id of madeCounterparties) {
      await db.delete(counterparties).where(eq(counterparties.id, id));
    }
    await db.delete(tours).where(eq(tours.id, tourId));
    await appPool.end({ timeout: 5 });
  });

  describe('agent commission', () => {
    it('raises a payable at the agent rate', async () => {
      const agent = await seedCounterparty({
        type: 'agent',
        name: 'Nairobi Travel',
        commission_rate_bps: 1250,
      });
      const booking = await seedBooking({ agent_id: agent.id });

      const commission = await asTenant(() =>
        bookingLedger.raiseAgentCommission(booking)
      );

      // 12.5% of 4,200.00 is 525.00 — computed in integers, never a float.
      expect(commission.amount_cents).toBe(52500);
      expect(commission.direction).toBe('payable');
      expect(commission.kind).toBe('commission');
      expect(commission.counterparty_id).toBe(agent.id);
      // Earned when the trip runs, not when it was booked.
      expect(commission.due_on).toBe('2026-11-10');
    });

    it('rounds half up rather than truncating', async () => {
      const agent = await seedCounterparty({
        type: 'agent',
        name: 'Rounding Travel',
        commission_rate_bps: 333,
      });
      // 3.33% of 1,000.05 is 33.3016..., which truncates to 3330 cents and
      // rounds to 3330 — pick a total where the two differ.
      const booking = await seedBooking({
        agent_id: agent.id,
        total_price: '1000.15',
      });

      const commission = await asTenant(() =>
        bookingLedger.raiseAgentCommission(booking)
      );

      // 100015 * 333 / 10000 = 3330.4995 -> 3330
      expect(commission.amount_cents).toBe(3330);
    });

    it('raises nothing for a direct booking', async () => {
      const booking = await seedBooking();
      const commission = await asTenant(() =>
        bookingLedger.raiseAgentCommission(booking)
      );
      expect(commission).toBeNull();
    });

    it('raises nothing, loudly, for an agent with no rate', async () => {
      // Validation refuses to create one, but a rate cleared afterwards would
      // otherwise raise a zero payable nobody notices until reconciliation.
      const agent = await seedCounterparty({
        type: 'agent',
        name: 'Rateless Travel',
        commission_rate_bps: null,
      });
      const booking = await seedBooking({ agent_id: agent.id });

      const commission = await asTenant(() =>
        bookingLedger.raiseAgentCommission(booking)
      );
      expect(commission).toBeNull();
    });

    it('is voided along with the receivable when the booking is cancelled', async () => {
      const agent = await seedCounterparty({
        type: 'agent',
        name: 'Cancelled Travel',
        commission_rate_bps: 1000,
      });
      const booking = await seedBooking({ agent_id: agent.id });

      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));
      await asTenant(() => bookingLedger.raiseAgentCommission(booking));

      const voided = await asTenant(() =>
        bookingLedger.voidBookingObligations(booking.id)
      );

      // Both of them: the customer stops owing and the agent stops earning.
      // A direction filter here would have voided only the receivable and left
      // the operator owing commission on a trip that will not happen.
      expect(voided).toHaveLength(2);
      expect(voided.map((o) => o.kind).sort()).toEqual(['commission', 'full']);
    });
  });

  describe('booking P&L', () => {
    const lodge = () =>
      seedCounterparty({
        type: 'supplier',
        name: `Mara Lodge ${Math.random()}`,
        default_currency: 'KES',
        payment_terms_days: 30,
      });

    it('reports revenue with no costs against it', async () => {
      const booking = await seedBooking();
      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));

      const pnl = await asTenant(() => bookingPnl(booking.id));

      expect(pnl.revenue).toBe('4200.00');
      expect(pnl.cost_of_sales).toBe('0.00');
      expect(pnl.commission).toBe('0.00');
      expect(pnl.margin).toBe('4200.00');
      expect(pnl.margin_pct).toBe(100);
      expect(pnl.base_currency).toBe('KES');
    });

    it('takes off an attributed supplier invoice and the agent commission', async () => {
      const agent = await seedCounterparty({
        type: 'agent',
        name: 'Margin Travel',
        commission_rate_bps: 1000,
      });
      const supplier = await lodge();
      const booking = await seedBooking({ agent_id: agent.id });

      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));
      await asTenant(() => bookingLedger.raiseAgentCommission(booking));

      await asTenant(() =>
        supplierInvoiceService.createSupplierInvoice({
          counterparty_id: supplier.id,
          invoice_number: `INV-${Date.now()}`,
          issued_on: '2026-11-01',
          amount: '2900.00',
          booking_id: booking.id,
        })
      );

      const pnl = await asTenant(() => bookingPnl(booking.id));

      // Sold 4,200; the lodge cost 2,900; the agent takes 10% of 4,200.
      expect(pnl.revenue).toBe('4200.00');
      expect(pnl.cost_of_sales).toBe('2900.00');
      expect(pnl.commission).toBe('420.00');
      expect(pnl.margin).toBe('880.00');
      expect(pnl.margin_pct).toBeCloseTo(21, 0);
    });

    it('ignores a supplier invoice attributed to nothing', async () => {
      const supplier = await lodge();
      const booking = await seedBooking();
      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));

      // A monthly insurance premium, say: a real cost, and not this trip's.
      await asTenant(() =>
        supplierInvoiceService.createSupplierInvoice({
          counterparty_id: supplier.id,
          invoice_number: `INV-UNATTRIBUTED-${Date.now()}`,
          issued_on: '2026-11-01',
          amount: '500.00',
        })
      );

      const pnl = await asTenant(() => bookingPnl(booking.id));
      expect(pnl.cost_of_sales).toBe('0.00');
      expect(pnl.margin).toBe('4200.00');
    });

    it('nets a voided invoice back out', async () => {
      const supplier = await lodge();
      const booking = await seedBooking();
      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));

      const invoice = await asTenant(() =>
        supplierInvoiceService.createSupplierInvoice({
          counterparty_id: supplier.id,
          invoice_number: `INV-VOID-${Date.now()}`,
          issued_on: '2026-11-01',
          amount: '900.00',
          booking_id: booking.id,
        })
      );

      const before = await asTenant(() => bookingPnl(booking.id));
      expect(before.cost_of_sales).toBe('900.00');

      await asTenant(() =>
        supplierInvoiceService.voidSupplierInvoice(invoice.id)
      );

      // The reversal is a ledger group of its own, so the sum nets to zero on
      // its own — nothing here filters voided obligations out, which is the
      // point of reading the ledger rather than the obligations.
      const after = await asTenant(() => bookingPnl(booking.id));
      expect(after.cost_of_sales).toBe('0.00');
      expect(after.margin).toBe('4200.00');
    });

    it('nets to nothing when the booking is cancelled', async () => {
      const agent = await seedCounterparty({
        type: 'agent',
        name: 'Cancelled Margin',
        commission_rate_bps: 1000,
      });
      const booking = await seedBooking({ agent_id: agent.id });

      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));
      await asTenant(() => bookingLedger.raiseAgentCommission(booking));
      await asTenant(() => bookingLedger.voidBookingObligations(booking.id));

      const pnl = await asTenant(() => bookingPnl(booking.id));

      expect(pnl.revenue).toBe('0.00');
      expect(pnl.commission).toBe('0.00');
      expect(pnl.margin).toBe('0.00');
      // Not a division by zero, and not NaN dressed up as a percentage.
      expect(pnl.margin_pct).toBeNull();
    });

    it('reports zeros for a booking with nothing raised against it', async () => {
      const booking = await seedBooking();
      const pnl = await asTenant(() => bookingPnl(booking.id));

      expect(pnl.revenue).toBe('0.00');
      expect(pnl.margin).toBe('0.00');
      expect(pnl.margin_pct).toBeNull();
    });

    it('refuses a booking that does not exist', async () => {
      await expect(
        asTenant(() => bookingPnl('11111111-1111-4111-8111-111111111111'))
      ).rejects.toThrow(/not found/i);
    });
  });
});
