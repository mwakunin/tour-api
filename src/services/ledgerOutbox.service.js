// src/services/ledgerOutbox.service.js
//
// Reading and writing the failed-accrual table. Nothing here knows how to
// perform a ledger operation — that lives in bookingLedger.service, which
// imports this one. Putting the retry here too would make the two import each
// other, and a cycle evaluated at module load is how this codebase produces
// "Cannot access X before initialization" (see CLAUDE.md).

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { ledger_outbox } from '#models/schema.js';
import logger from '#config/logger.js';

/**
 * Records that a ledger write failed, or bumps the entry if it already had.
 *
 * One row per (operation, subject): five failed retries of one booking are one
 * problem to work through, not five. attempts carries the history instead.
 *
 * NEVER THROWS. This is called from the catch block of something that has
 * already decided to carry on — a booking that must not fail because its
 * accrual did. Throwing here would turn the failure it is recording into the
 * failure it was written to prevent.
 */
export const recordFailure = async ({ operation, subjectId, error }) => {
  try {
    const [row] = await withTenantDb((tx) =>
      tx
        .insert(ledger_outbox)
        .values({
          tenant_id: currentTenantId(),
          operation,
          subject_id: subjectId,
          attempts: 1,
          last_error: String(error?.message ?? error).slice(0, 2000),
          last_attempted_at: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            ledger_outbox.tenant_id,
            ledger_outbox.operation,
            ledger_outbox.subject_id,
          ],
          set: {
            attempts: sql`${ledger_outbox.attempts} + 1`,
            last_error: String(error?.message ?? error).slice(0, 2000),
            last_attempted_at: new Date(),
            // Reopened. An entry that succeeded once and failed again is
            // outstanding, and keeping its attempt count is the useful part.
            resolved_at: null,
            resolution: null,
            updated_at: new Date(),
          },
        })
        .returning()
    );
    return row;
  } catch (writeError) {
    logger.error('[ledgerOutbox] could not record a failed ledger write', {
      operation,
      subjectId,
      original: error?.message,
      writeError: writeError.message,
    });
    return null;
  }
};

/** Marks an entry done, with a note saying how it ended. */
export const resolveEntry = (id, resolution) =>
  withTenantDb((tx) =>
    tx
      .update(ledger_outbox)
      .set({
        resolved_at: new Date(),
        resolution,
        updated_at: new Date(),
      })
      .where(eq(ledger_outbox.id, id))
      .returning()
  );

/** Records a retry that failed again, without resolving it. */
export const noteAttempt = (id, error) =>
  withTenantDb((tx) =>
    tx
      .update(ledger_outbox)
      .set({
        attempts: sql`${ledger_outbox.attempts} + 1`,
        last_error: String(error?.message ?? error).slice(0, 2000),
        last_attempted_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(ledger_outbox.id, id))
      .returning()
  );

/**
 * Outstanding entries, least recently attempted first.
 *
 * NOT oldest-created first, which is what this did. The drain takes a bounded
 * page, so with `limit` entries that fail permanently — fifty bookings in a
 * currency with no rate, say — every drain re-read the same fifty and no
 * failure filed afterwards was ever looked at again. The queue had a head, and
 * it blocked.
 *
 * Ordering by the last attempt rotates instead: retrying an entry pushes it to
 * the back, so the next page reaches what has waited longest. Nothing is
 * starved and nothing is abandoned — see the note on `attempts` in the model
 * for why entries are counted rather than capped.
 *
 * NULLS FIRST is explicit because Postgres puts them LAST in ASC, and an entry
 * never attempted should be first in line, not last.
 */
export const pendingEntries = (limit = 50) =>
  withTenantDb((tx) =>
    tx
      .select()
      .from(ledger_outbox)
      .where(
        and(
          eq(ledger_outbox.tenant_id, currentTenantId()),
          isNull(ledger_outbox.resolved_at)
        )
      )
      .orderBy(
        sql`${ledger_outbox.last_attempted_at} ASC NULLS FIRST`,
        asc(ledger_outbox.created_at)
      )
      .limit(limit)
  );

/** Everything in the outbox, newest first, for the operator's worklist. */
export const listEntries = ({ page = 1, limit = 50, pending } = {}) => {
  const offset = (page - 1) * limit;
  const scope = and(
    eq(ledger_outbox.tenant_id, currentTenantId()),
    pending === true ? isNull(ledger_outbox.resolved_at) : undefined
  );

  return withTenantDb(async (tx) => {
    const rows = await tx
      .select()
      .from(ledger_outbox)
      .where(scope)
      .orderBy(desc(ledger_outbox.created_at))
      .limit(limit)
      .offset(offset);

    const [totals] = await tx
      .select({ total: sql`count(*)::int` })
      .from(ledger_outbox)
      .where(scope);

    return { data: rows, total: Number(totals?.total ?? 0), page, limit };
  });
};
