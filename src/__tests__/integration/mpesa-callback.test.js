// src/__tests__/integration/mpesa-callback.test.js
//
// The real M-Pesa service, not the mock payments.test.js installs. Two things
// here had no coverage at all: what Safaricom is actually asked to collect,
// and whether what it reports back is checked against it.

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, initDatabase } from '#config/database.js';
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
import {
  chargeableCents,
  handleMpesaCallback,
} from '#services/mpesa.service.js';

const asTenant = (fn) => runWithTenant(SEED_TENANT_ID, fn);

let tourId;
const createdBookings = [];

const seedBooking = async (totalCents) => {
  const [booking] = await db
    .insert(bookings)
    .values({
      tenant_id: SEED_TENANT_ID,
      booking_reference: `MC-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      tour_id: tourId,
      group_size: 1,
      start_date: new Date('2026-12-01'),
      end_date: new Date('2026-12-05'),
      price_per_person_cents: totalCents,
      total_price_cents: totalCents,
      currency: 'KES',
      customer_name: 'Wanjiku Test',
      customer_email: 'wanjiku@example.com',
    })
    .returning();
  createdBookings.push(booking.id);
  return booking;
};

const seedPendingPayment = async (bookingId, amountCents, checkoutId) => {
  const [payment] = await db
    .insert(payments)
    .values({
      tenant_id: SEED_TENANT_ID,
      booking_id: bookingId,
      amount_cents: amountCents,
      currency: 'KES',
      payment_method: 'mpesa',
      status: 'pending',
      checkout_request_id: checkoutId,
    })
    .returning();
  return payment;
};

const callback = (checkoutId, items) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: 'mr-1',
      CheckoutRequestID: checkoutId,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: { Item: items },
    },
  },
});

describe('M-Pesa', () => {
  beforeAll(async () => {
    await initDatabase();
    const [tour] = await db
      .insert(tours)
      .values({
        tenant_id: SEED_TENANT_ID,
        title: 'M-Pesa Callback Test Tour',
        slug: `mpesa-callback-${Date.now()}`,
        overview: 'Seeded for the M-Pesa callback tests.',
        duration: 4,
        price_amount: '100.00',
        price_currency: 'KES',
        status: 'published',
      })
      .returning();
    tourId = tour.id;
  });

  afterAll(async () => {
    for (const id of createdBookings) {
      const rows = await db
        .select({ id: obligations.id })
        .from(obligations)
        .where(eq(obligations.source_id, id));
      for (const row of rows) {
        await db
          .delete(ledger_entries)
          .where(eq(ledger_entries.source_id, row.id));
        await db
          .delete(allocations)
          .where(eq(allocations.obligation_id, row.id));
      }
      const paid = await db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.booking_id, id));
      for (const p of paid) {
        await db.delete(allocations).where(eq(allocations.settlement_id, p.id));
        await db.delete(settlements).where(eq(settlements.payment_id, p.id));
      }
      await db.delete(obligations).where(eq(obligations.source_id, id));
      await db.delete(payments).where(eq(payments.booking_id, id));
      await db.delete(bookings).where(eq(bookings.id, id));
    }
    await db.delete(tours).where(eq(tours.id, tourId));
    await appPool.end({ timeout: 5 });
  });

  describe('what the customer is charged', () => {
    it('rounds a part-shilling amount up, never down', () => {
      // Daraja takes whole shillings. Rounding to nearest sent 100.40 as 100,
      // and the callback then marked the booking paid with 40 cents owed.
      expect(chargeableCents('100.40')).toBe(10100);
      expect(chargeableCents('100.50')).toBe(10100);
      expect(chargeableCents('100.99')).toBe(10100);
    });

    it('leaves a whole shilling alone', () => {
      // The float route — Math.ceil(parseFloat(x) ) on a computed total — can
      // push an exact amount to the next shilling. The integer one cannot.
      expect(chargeableCents('100.00')).toBe(10000);
      expect(chargeableCents('100')).toBe(10000);
      expect(chargeableCents('1.15')).toBe(200);
    });
  });

  describe('what Safaricom reports back', () => {
    it('completes a callback that reports the amount charged', async () => {
      const booking = await seedBooking(10000);
      const checkoutId = `ws_CO_ok_${Date.now()}`;
      await seedPendingPayment(booking.id, 10000, checkoutId);

      const result = await asTenant(() =>
        handleMpesaCallback(
          callback(checkoutId, [
            { Name: 'Amount', Value: 100 },
            { Name: 'MpesaReceiptNumber', Value: 'SGH7OK0001' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ])
        )
      );

      expect(result.success).toBe(true);

      const [row] = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(payments)
            .where(eq(payments.checkout_request_id, checkoutId))
        )
      );
      expect(row.status).toBe('completed');
    });

    it('refuses a callback reporting a different amount', async () => {
      const booking = await seedBooking(10000);
      const checkoutId = `ws_CO_bad_${Date.now()}`;
      await seedPendingPayment(booking.id, 10000, checkoutId);

      const result = await asTenant(() =>
        handleMpesaCallback(
          callback(checkoutId, [
            { Name: 'Amount', Value: 1 },
            { Name: 'MpesaReceiptNumber', Value: 'SGH7BAD001' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ])
        )
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe('mismatch');

      // Nothing was claimed, so a corrected callback can still complete it.
      const [row] = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(payments)
            .where(eq(payments.checkout_request_id, checkoutId))
        )
      );
      expect(row.status).toBe('pending');
    });

    it('refuses a success callback that reports no amount at all', async () => {
      const booking = await seedBooking(10000);
      const checkoutId = `ws_CO_none_${Date.now()}`;
      await seedPendingPayment(booking.id, 10000, checkoutId);

      const result = await asTenant(() =>
        handleMpesaCallback(
          callback(checkoutId, [
            { Name: 'MpesaReceiptNumber', Value: 'SGH7NONE01' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ])
        )
      );

      // Absent is not the same as matching. Completing here would be
      // completing on the assumption that it would have matched.
      expect(result.success).toBe(false);
      expect(result.status).toBe('mismatch');
    });
  });
});
