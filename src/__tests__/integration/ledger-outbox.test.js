// src/__tests__/integration/ledger-outbox.test.js
//
// bookingLedger is deliberately forgiving — a booking must not fail because
// its accrual did. Until now the whole cost of that landed in a log line, and
// nobody reads logs looking for revenue that was never accrued. These cover
// the table that replaces the log line, and the property that makes retrying
// safe: replaying must not post the same money twice.

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { db, initDatabase } from '#config/database.js';
import { appPool } from '#config/appDatabase.js';
import { runWithTenant, withTenantDb } from '#config/tenantContext.js';
import { SEED_TENANT_ID } from '#middleware/tenant.middleware.js';
import {
  tours,
  bookings,
  obligations,
  ledger_entries,
  ledger_outbox,
} from '#models/schema.js';
import * as bookingLedger from '#services/bookingLedger.service.js';
import * as outbox from '#services/ledgerOutbox.service.js';

const asTenant = (fn) => runWithTenant(SEED_TENANT_ID, fn);

let tourId;
const created = [];

const seedBooking = async (totalCents = 420000) => {
  const [booking] = await db
    .insert(bookings)
    .values({
      tenant_id: SEED_TENANT_ID,
      booking_reference: `OB-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      tour_id: tourId,
      group_size: 2,
      start_date: new Date('2026-11-10'),
      end_date: new Date('2026-11-17'),
      price_per_person_cents: Math.round(totalCents / 2),
      total_price_cents: totalCents,
      currency: 'KES',
      customer_name: 'Outbox Traveller',
      customer_email: 'outbox@example.com',
    })
    .returning();
  created.push(booking.id);
  return booking;
};

const cleanup = async (bookingId) => {
  const rows = await db
    .select({ id: obligations.id })
    .from(obligations)
    .where(eq(obligations.source_id, bookingId));
  for (const row of rows) {
    await db.delete(ledger_entries).where(eq(ledger_entries.source_id, row.id));
  }
  await db.delete(obligations).where(eq(obligations.source_id, bookingId));
  await db.delete(ledger_outbox).where(eq(ledger_outbox.subject_id, bookingId));
  await db.delete(bookings).where(eq(bookings.id, bookingId));
};

describe('the ledger outbox', () => {
  beforeAll(async () => {
    await initDatabase();
    const [tour] = await db
      .insert(tours)
      .values({
        tenant_id: SEED_TENANT_ID,
        title: 'Outbox Test Tour',
        slug: `outbox-test-tour-${Date.now()}`,
        overview: 'Seeded for the outbox tests.',
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

  describe('what makes a retry safe', () => {
    it('does not accrue the same booking twice', async () => {
      const booking = await seedBooking();

      const first = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );
      const second = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      expect(first).toHaveLength(1);
      // The same obligation back, not a second one. Without this the drain
      // would post the booking's revenue again on every single pass.
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe(first[0].id);

      const all = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(obligations)
            .where(eq(obligations.source_id, booking.id))
        )
      );
      expect(all).toHaveLength(1);
    });

    it('refuses a duplicate accrual at the database, not just in code', async () => {
      const booking = await seedBooking();
      const [existing] = await asTenant(() =>
        bookingLedger.raiseBookingReceivable(booking)
      );

      // The check in bookingLedger is the clean path; this index is what holds
      // when two drains run at once and both see nothing.
      const failure = await db
        .insert(obligations)
        .values({
          tenant_id: SEED_TENANT_ID,
          direction: existing.direction,
          kind: existing.kind,
          source_type: 'booking',
          source_id: booking.id,
          amount_cents: 100,
          currency: 'KES',
          status: 'open',
        })
        .catch((error) => error);

      // 23505 is unique_violation.
      expect(failure.cause?.code).toBe('23505');
    });
  });

  describe('recording a failure', () => {
    it('files one entry per subject and counts the attempts', async () => {
      const booking = await seedBooking();

      await asTenant(() =>
        outbox.recordFailure({
          operation: 'booking_receivable',
          subjectId: booking.id,
          error: new Error('no rate loaded'),
        })
      );
      await asTenant(() =>
        outbox.recordFailure({
          operation: 'booking_receivable',
          subjectId: booking.id,
          error: new Error('still no rate loaded'),
        })
      );

      const rows = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(ledger_outbox)
            .where(eq(ledger_outbox.subject_id, booking.id))
        )
      );

      // One problem, not two. Five failed retries of one booking would
      // otherwise be five rows for somebody to work through.
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(2);
      expect(rows[0].last_error).toMatch(/still no rate loaded/);
      expect(rows[0].resolved_at).toBeNull();
    });

    it('never throws, even when it cannot write', async () => {
      // Called from the catch block of something that already decided to carry
      // on. Throwing here turns the failure it is recording into the failure
      // it exists to prevent. No tenant context, so withTenantDb rejects.
      await expect(
        outbox.recordFailure({
          operation: 'booking_receivable',
          subjectId: '11111111-2222-4333-8444-555555555555',
          error: new Error('original'),
        })
      ).resolves.toBeNull();
    });
  });

  describe('draining', () => {
    it('replays a filed failure and resolves it', async () => {
      const booking = await seedBooking();

      // The accrual never happened, and the outbox knows.
      await asTenant(() =>
        outbox.recordFailure({
          operation: 'booking_receivable',
          subjectId: booking.id,
          error: new Error('transient'),
        })
      );

      const result = await asTenant(() => bookingLedger.drainOutbox());
      expect(result.resolved).toBeGreaterThanOrEqual(1);

      const raised = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(obligations)
            .where(eq(obligations.source_id, booking.id))
        )
      );
      expect(raised).toHaveLength(1);

      const [entry] = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(ledger_outbox)
            .where(eq(ledger_outbox.subject_id, booking.id))
        )
      );
      expect(entry.resolved_at).not.toBeNull();
      expect(entry.resolution).toMatch(/^raised /);
    });

    it('resolves an entry whose booking has since gone', async () => {
      const booking = await seedBooking();
      await asTenant(() =>
        outbox.recordFailure({
          operation: 'booking_receivable',
          subjectId: booking.id,
          error: new Error('transient'),
        })
      );
      await db.delete(bookings).where(eq(bookings.id, booking.id));

      await asTenant(() => bookingLedger.drainOutbox());

      // Retrying forever against a row that no longer exists is the
      // logged-and-forgotten failure this table replaces, wearing a new hat.
      const [entry] = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(ledger_outbox)
            .where(eq(ledger_outbox.subject_id, booking.id))
        )
      );
      expect(entry.resolved_at).not.toBeNull();
      expect(entry.resolution).toBe('booking no longer exists');
    });

    it('leaves one bad entry without stopping the others', async () => {
      const good = await seedBooking();
      const goneId = '99999999-8888-4777-8666-555555555555';

      await asTenant(() =>
        outbox.recordFailure({
          operation: 'booking_settlement',
          subjectId: goneId,
          error: new Error('no such payment'),
        })
      );
      await asTenant(() =>
        outbox.recordFailure({
          operation: 'booking_receivable',
          subjectId: good.id,
          error: new Error('transient'),
        })
      );

      const result = await asTenant(() => bookingLedger.drainOutbox());

      // The point of draining a batch: one entry that cannot be replayed must
      // not hold up the ones that can.
      expect(result.attempted).toBeGreaterThanOrEqual(2);
      const raised = await asTenant(() =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(obligations)
            .where(
              and(
                eq(obligations.source_id, good.id),
                eq(obligations.direction, 'receivable')
              )
            )
        )
      );
      expect(raised).toHaveLength(1);

      await db
        .delete(ledger_outbox)
        .where(eq(ledger_outbox.subject_id, goneId));
    });
  });
});
