import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from '@jest/globals';
import { eq, sql } from 'drizzle-orm';

import { db } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import {
  tenants,
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
import { decimalToCents } from '#utils/money.js';

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
      price_per_person_cents: decimalToCents(totalPrice),
      total_price_cents: decimalToCents(totalPrice),
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
      amount_cents: decimalToCents(amount),
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

    const raised = await asTenant(() =>
      bookingLedger.raiseBookingReceivable(booking)
    );

    // One obligation, because the seeded tenant has no deposit policy.
    expect(raised).toHaveLength(1);
    const [obligation] = raised;
    expect(obligation.direction).toBe('receivable');
    expect(obligation.kind).toBe('full');
    expect(obligation.amount_cents).toBe(420000); // "4200.00" -> cents, exactly
    expect(obligation.source_type).toBe('booking');
  });

  it('turns a completed payment into a settlement and clears the balance', async () => {
    const booking = await seedBooking('1000.00');
    created.push(booking.id);

    const [obligation] = await asTenant(() =>
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

    // Corrupt the cents, not the decimal: `amount` is a generated column now
    // and the ledger reads amount_cents, so a bad string there is what a
    // failure actually looks like from here.
    const result = await asTenant(() =>
      bookingLedger.recordBookingSettlement({
        payment: { ...payment, amount_cents: 'not-a-number' },
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
    expect(result).toEqual([]);
  });

  it('voids open receivables when a booking is cancelled', async () => {
    const booking = await seedBooking('2500.00');
    created.push(booking.id);

    await asTenant(() => bookingLedger.raiseBookingReceivable(booking));
    const voided = await asTenant(() =>
      bookingLedger.voidBookingObligations(booking.id)
    );

    expect(voided).toHaveLength(1);
    expect(voided[0].status).toBe('void');
  });

  describe('money is stored as integer cents', () => {
    it('keeps the cents exact and still reports the decimal', async () => {
      const booking = await seedBooking('1000.15');
      created.push(booking.id);

      // The cents are what is written; the decimal is generated from them, so
      // the API contract the frontend reads is unchanged.
      expect(booking.total_price_cents).toBe(100015);
      expect(booking.total_price).toBe('1000.15');
    });

    it('refuses a write to the derived decimal column', async () => {
      const booking = await seedBooking('1000.00');
      created.push(booking.id);

      // The guarantee the whole change rests on. Two columns kept in step by
      // convention drift; this one cannot be written at all, so there is no
      // convention left to break.
      const failure = await db
        .execute(
          sql`UPDATE bookings SET total_price = 1 WHERE id = ${booking.id}`
        )
        .catch((error) => error);

      // 428C9 is ERRCODE_GENERATED_ALWAYS. Asserted on the code rather than
      // the text, which is translated. Drizzle wraps the driver error, so the
      // real one is on .cause — the same place the 23505 checks read.
      expect(failure.cause?.code).toBe('428C9');
    });
  });

  describe('with a deposit policy configured', () => {
    // Set on the seeded tenant and cleared afterwards. Owner-plane, because
    // deposit terms are operator configuration and the runtime role is not
    // allowed to write them.
    const setPolicy = async (bps, daysBefore) =>
      db
        .update(tenants)
        .set({
          deposit_percent_bps: bps,
          balance_due_days_before_departure: daysBefore,
        })
        .where(eq(tenants.id, SEED_TENANT_ID));

    afterEach(() => setPolicy(null, null));

    it('splits the booking into a deposit and a balance that sum to it', async () => {
      await setPolicy(3000, 30); // 30% now, balance 30 days before departure
      const booking = await seedBooking('1000.00');
      created.push(booking.id);

      const raised = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      expect(raised).toHaveLength(2);
      const [deposit, balance] = raised;

      expect(deposit.kind).toBe('deposit');
      expect(deposit.amount_cents).toBe(30000);
      expect(balance.kind).toBe('balance');
      expect(balance.amount_cents).toBe(70000);

      // The property that matters more than either figure: nothing is lost
      // between the two legs.
      expect(deposit.amount_cents + balance.amount_cents).toBe(100000);

      // start_date is 2026-11-10; 30 days earlier is 2026-10-11.
      expect(balance.due_on).toBe('2026-10-11');
      // Explicitly dated, not null — a null due_on sorts LAST in ASC, so the
      // customer's first payment would be spent on the balance leg.
      expect(deposit.due_on).not.toBeNull();
      expect(deposit.due_on < balance.due_on).toBe(true);
    });

    it('leaves no cent unassigned when the split does not divide evenly', async () => {
      // 50% of an odd number of cents lands exactly on half a cent, so
      // rounding half up takes it. A balance computed as its own percentage
      // rounds the other half up too and the pair overcharges by a cent; as
      // the remainder it cannot. This case was chosen because it is one of the
      // few that tells the two apart — 3333 bps of the same total does not.
      await setPolicy(5000, 30);
      const booking = await seedBooking('100.01');
      created.push(booking.id);

      const [deposit, balance] = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      expect(deposit.amount_cents).toBe(5001);
      expect(balance.amount_cents).toBe(5000);
      expect(deposit.amount_cents + balance.amount_cents).toBe(10001);
    });

    it('spends the first payment on the deposit, not the balance', async () => {
      await setPolicy(3000, 30);
      const booking = await seedBooking('1000.00');
      created.push(booking.id);

      const [deposit] = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      const payment = await seedPayment(booking.id, '300.00', {
        mpesa_receipt_number: `DEP${Date.now().toString(36).slice(-7)}`,
      });
      await asTenant(() =>
        bookingLedger.recordBookingSettlement({ payment, booking })
      );

      const rows = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(allocations)
            .where(eq(allocations.obligation_id, deposit.id))
        )
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].amount_cents).toBe(30000);
    });

    it('clamps a balance date that has already passed to today', async () => {
      // A booking made inside the notice period. The balance is genuinely due
      // now; backdating it would only make it look overdue for longer.
      await setPolicy(3000, 3650);
      const booking = await seedBooking('1000.00');
      created.push(booking.id);

      const [, balance] = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      expect(balance.due_on).toBe(new Date().toISOString().slice(0, 10));
    });

    it('raises one obligation when the percentage rounds away', async () => {
      // 1 bps of 2 cents rounds to nothing, so there is no first leg and
      // therefore no schedule. Falls back rather than posting a zero.
      await setPolicy(1, 30);
      const booking = await seedBooking('0.02');
      created.push(booking.id);

      const raised = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      expect(raised).toHaveLength(1);
      expect(raised[0].kind).toBe('full');
      expect(raised[0].amount_cents).toBe(2);
    });

    it('voids both legs when the booking is cancelled', async () => {
      await setPolicy(3000, 30);
      const booking = await seedBooking('1000.00');
      created.push(booking.id);

      await asTenant(() => bookingLedger.raiseBookingReceivable(booking));
      const voided = await asTenant(() =>
        bookingLedger.voidBookingObligations(booking.id)
      );

      // voidBookingObligations was never filtered by kind, so this passes for
      // the same reason it passed with one obligation. Pinned because a
      // schedule is exactly the thing that would tempt someone to filter.
      expect(voided).toHaveLength(2);
      expect(voided.every((row) => row.status === 'void')).toBe(true);
    });
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
      bookingLedger.voidBookingObligations(booking.id)
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
