// src/__tests__/integration/mpesa-callback.test.js
//
// The real M-Pesa service, not the mock payments.test.js installs. Two things
// here had no coverage at all: what Safaricom is actually asked to collect,
// and whether what it reports back is checked against it.

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';
import { eq } from 'drizzle-orm';

// handleMpesaCallback now asks Safaricom to confirm the push before it
// completes anything, so these have to control that answer. Daraja is reached
// only through axios — .get for the OAuth token, .post for the status query —
// so mocking the module is enough, and it keeps the service under test real.
const axiosGet = jest.fn(async () => ({
  data: { access_token: 'test-access-token' },
}));
const axiosPost = jest.fn(async () => ({
  data: {
    ResultCode: '0',
    ResultDesc: 'The service request is processed successfully.',
  },
}));

jest.unstable_mockModule('axios', () => ({
  default: { get: axiosGet, post: axiosPost },
  get: axiosGet,
  post: axiosPost,
}));

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
// Dynamic, and after the mock is registered — a static import of anything
// that transitively pulls in axios would bind the real one first. See the ESM
// mocking note in CLAUDE.md.
const { chargeableCents, handleMpesaCallback } =
  await import('#services/mpesa.service.js');

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

  beforeEach(() => {
    axiosGet.mockClear();
    axiosPost.mockClear();
    axiosPost.mockResolvedValue({
      data: {
        ResultCode: '0',
        ResultDesc: 'The service request is processed successfully.',
      },
    });
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

  describe('whether Safaricom agrees it happened', () => {
    // The endpoint is public — Safaricom has to be able to reach it — and
    // Daraja does not sign STK callbacks, so there is nothing to verify on the
    // request itself. Anyone who could POST a success payload naming a pending
    // CheckoutRequestID used to get a booking confirmed for free, and the
    // realistic attacker is the customer who started a real push, was handed
    // the id, cancelled on their handset and replayed a success.
    it('refuses a callback Safaricom does not confirm', async () => {
      const booking = await seedBooking(10000);
      const checkoutId = `ws_CO_forged_${Date.now()}`;
      await seedPendingPayment(booking.id, 10000, checkoutId);

      // 1032 is "request cancelled by user" — exactly what the query returns
      // for a push the customer dismissed.
      axiosPost.mockResolvedValue({
        data: { ResultCode: '1032', ResultDesc: 'Request cancelled by user' },
      });

      const result = await asTenant(() =>
        handleMpesaCallback(
          callback(checkoutId, [
            { Name: 'Amount', Value: 100 },
            { Name: 'MpesaReceiptNumber', Value: 'FORGED0001' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ])
        )
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe('unconfirmed');

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

    it('completes nothing when Safaricom cannot be reached', async () => {
      const booking = await seedBooking(10000);
      const checkoutId = `ws_CO_down_${Date.now()}`;
      await seedPendingPayment(booking.id, 10000, checkoutId);

      axiosPost.mockRejectedValue(new Error('ETIMEDOUT'));

      // Throws rather than returning, so the controller answers non-zero and
      // Safaricom retries. A query that could not be reached is not a
      // confirmation, and completing on a maybe is the whole thing being
      // avoided.
      await expect(
        asTenant(() =>
          handleMpesaCallback(
            callback(checkoutId, [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'TIMEOUT001' },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ])
          )
        )
      ).rejects.toThrow();

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

    it('refuses a malformed amount instead of erroring', async () => {
      const booking = await seedBooking(10000);
      const checkoutId = `ws_CO_junk_${Date.now()}`;
      await seedPendingPayment(booking.id, 10000, checkoutId);

      const result = await asTenant(() =>
        handleMpesaCallback(
          callback(checkoutId, [
            { Name: 'Amount', Value: 'one hundred' },
            { Name: 'MpesaReceiptNumber', Value: 'SGH7JUNK01' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ])
        )
      );

      // decimalToCents throws on anything that is not a decimal. Letting that
      // escape answered the callback 500, so Safaricom retried a payload that
      // will never parse rather than being told the amount was refused.
      expect(result.success).toBe(false);
      expect(result.status).toBe('mismatch');
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
