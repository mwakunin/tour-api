import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import {
  tours,
  bookings,
  payments,
  obligations,
  settlements,
  allocations,
  ledger_entries,
} from '#models/schema.js';
import * as bookingLedger from '#services/bookingLedger.service.js';
import * as money from '#services/money.service.js';

const asTenant = (fn) => runWithTenant(SEED_TENANT_ID, fn);

// Real rows, not booking-shaped literals. settlements.payment_id carries a
// composite (tenant_id, payment_id) foreign key, so a fabricated id is
// rejected — which is the constraint working, and a reason to test against
// what production actually has.
let tourId;

const seedBooking = async (totalPrice = '4200.00') => {
  const [booking] = await db
    .insert(bookings)
    .values({
      tenant_id: SEED_TENANT_ID,
      // booking_reference is varchar(20); base36 keeps it unique and short.
      booking_reference: `FL-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      tour_id: tourId,
      group_size: 2,
      start_date: new Date('2026-11-10'),
      end_date: new Date('2026-11-17'),
      price_per_person: totalPrice,
      total_price: totalPrice,
      currency: 'KES',
      customer_name: 'Jane Traveller',
      customer_email: 'jane@example.com',
    })
    .returning();
  return booking;
};

const seedPayment = async (bookingId, amount, overrides = {}) => {
  const [payment] = await db
    .insert(payments)
    .values({
      tenant_id: SEED_TENANT_ID,
      booking_id: bookingId,
      amount,
      currency: 'KES',
      payment_method: 'mpesa',
      status: 'completed',
      completed_at: new Date(),
      ...overrides,
    })
    .returning();
  return payment;
};

const cleanup = async (bookingId) => {
  const rows = await db
    .select({ id: obligations.id })
    .from(obligations)
    .where(eq(obligations.source_id, bookingId));
  for (const { id } of rows) {
    await db.delete(allocations).where(eq(allocations.obligation_id, id));
    await db.delete(ledger_entries).where(eq(ledger_entries.source_id, id));
    await db.delete(obligations).where(eq(obligations.id, id));
  }
  const sets = await db
    .select({ id: settlements.id })
    .from(settlements)
    .where(eq(settlements.notes, bookingId));
  for (const { id } of sets) {
    await db.delete(allocations).where(eq(allocations.settlement_id, id));
    await db.delete(ledger_entries).where(eq(ledger_entries.source_id, id));
    await db.delete(settlements).where(eq(settlements.id, id));
  }
  await db.delete(payments).where(eq(payments.booking_id, bookingId));
  await db.delete(bookings).where(eq(bookings.id, bookingId));
};

describe('booking -> money layer bridge', () => {
  const created = [];

  beforeAll(async () => {
    const [tour] = await db
      .insert(tours)
      .values({
        tenant_id: SEED_TENANT_ID,
        title: 'Ledger Test Tour',
        slug: `ledger-test-tour-${Date.now()}`,
        overview: 'Seeded for the booking/money bridge tests.',
        duration: 7,
        price_amount: '4200.00',
        price_currency: 'KES',
        status: 'published',
      })
      .returning();
    tourId = tour.id;
  });

  afterAll(async () => {
    for (const id of created) await cleanup(id);
    await db.delete(tours).where(eq(tours.id, tourId));
    await appPool.end({ timeout: 5 });
  });

  it('raises a receivable for the booking total', async () => {
    const booking = await seedBooking('4200.00');
    created.push(booking.id);

    const obligation = await asTenant(() =>
      bookingLedger.raiseBookingReceivable(booking)
    );

    expect(obligation).not.toBeNull();
    expect(obligation.direction).toBe('receivable');
    expect(obligation.amount_cents).toBe(420000); // "4200.00" -> cents, exactly
    expect(obligation.source_type).toBe('booking');
  });

  it('turns a completed payment into a settlement and clears the balance', async () => {
    const booking = await seedBooking('1000.00');
    created.push(booking.id);

    const obligation = await asTenant(() =>
      bookingLedger.raiseBookingReceivable(booking)
    );

    const payment = await seedPayment(booking.id, '400.00', {
      mpesa_receipt_number: 'SGH7TEST01',
    });

    const settlement = await asTenant(() =>
      bookingLedger.recordBookingSettlement({ payment, booking })
    );

    expect(settlement).not.toBeNull();
    expect(settlement.external_reference).toBe('SGH7TEST01');

    const left = await asTenant(() =>
      withTenantDb((tx) => money.outstandingCentsFor(tx, obligation.id))
    );
    expect(left).toBe(60000); // 1000.00 sold, 400.00 paid -> 600.00 outstanding
  });

  it('never throws when the ledger cannot be written', async () => {
    // The customer's money has already moved. A failed accrual is a
    // reconciliation problem; rejecting a payment Safaricom already took is
    // not an acceptable alternative.
    const booking = await seedBooking('500.00');
    created.push(booking.id);
    const payment = await seedPayment(booking.id, '100.00');

    const result = await asTenant(() =>
      bookingLedger.recordBookingSettlement({
        payment: { ...payment, amount: 'not-a-number' },
      })
    );
    expect(result).toBeNull();
  });

  it('skips a non-positive booking total rather than posting a bad accrual', async () => {
    const booking = await seedBooking('0.00');
    created.push(booking.id);
    const result = await asTenant(() =>
      bookingLedger.raiseBookingReceivable(booking)
    );
    expect(result).toBeNull();
  });

  it('voids open receivables when a booking is cancelled', async () => {
    const booking = await seedBooking('2500.00');
    created.push(booking.id);

    await asTenant(() => bookingLedger.raiseBookingReceivable(booking));
    const voided = await asTenant(() =>
      bookingLedger.voidBookingReceivables(booking.id)
    );

    expect(voided).toHaveLength(1);
    expect(voided[0].status).toBe('void');
  });

  it('leaves a settlement unallocated when it matches no booking', async () => {
    // A real booking with no receivable raised: the money arrives before
    // anyone has recorded what it is for.
    const booking = await seedBooking('75.00');
    created.push(booking.id);
    const payment = await seedPayment(booking.id, '75.00', {
      mpesa_receipt_number: 'UNMATCHED01',
    });

    const settlement = await asTenant(() =>
      bookingLedger.recordBookingSettlement({ payment })
    );

    expect(settlement).not.toBeNull();
    const left = await asTenant(() =>
      withTenantDb((tx) => money.unallocatedCentsFor(tx, settlement.id))
    );
    // Stays on the unmatched-receipts worklist rather than being forced
    // somewhere it does not belong.
    expect(left).toBe(7500);
  });

  it('reports a failed void instead of swallowing it', async () => {
    const booking = await seedBooking('310.00');
    created.push(booking.id);
    await asTenant(() => bookingLedger.raiseBookingReceivable(booking));

    // Called with no tenant context, so withTenantDb rejects. The failure
    // itself is not the point -- what it stands in for is any failure to
    // void: this used to be caught and turned into an empty array, so the
    // cancellation that called it committed and answered success while the
    // receivable stayed open and its revenue stayed credited, with nothing
    // left to retry from. It has to reach the caller so the surrounding
    // transaction rolls back.
    await expect(
      bookingLedger.voidBookingReceivables(booking.id)
    ).rejects.toThrow(/tenant context/);

    // And the receivable is untouched, not half-voided.
    const still = await asTenant(() =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(obligations)
          .where(eq(obligations.source_id, booking.id))
      )
    );
    expect(still).toHaveLength(1);
    expect(still[0].status).toBe('open');
  });
});
