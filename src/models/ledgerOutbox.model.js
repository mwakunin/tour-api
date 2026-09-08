// src/models/ledgerOutbox.model.js
//
// Failed ledger writes, kept so they can be retried.
//
// bookingLedger.service is deliberately forgiving: a booking must not fail
// because its accrual did, and a payment Safaricom has already taken must not
// be rejected because the ledger entry would not write. That decision is
// right, and until now its whole cost landed in one place — the failure was
// logged and nothing else. Nobody reads logs looking for revenue that was
// never accrued, so the books stayed wrong and the only record of it aged out
// of retention.
//
// A row here is that same failure, in a table somebody can query, with a way
// to try again.
//
// IT STORES THE OPERATION AND THE ROW, NOT THE ARGUMENTS.
//
// A serialised payload replayed an hour later writes what was true when it was
// captured. Re-reading the booking or the payment writes what is true now,
// which is the only version worth posting to a ledger.

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';

import { ledgerOutboxOperationEnum } from './enums.model.js';
import { tenants } from './tenant.model.js';

export const ledger_outbox = pgTable(
  'ledger_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    operation: ledgerOutboxOperationEnum('operation').notNull(),

    // The booking or the payment the operation concerns. Not a foreign key:
    // which table it points at depends on the operation, and a composite FK
    // cannot branch. The drain re-reads it and resolves the entry if the row
    // has since gone.
    subject_id: uuid('subject_id').notNull(),

    // Counted rather than capped here. What to do after N failures is an
    // operator's decision, and a row that stops being retried silently is the
    // logged-and-forgotten failure this table exists to replace.
    attempts: integer('attempts').default(0).notNull(),
    last_error: text('last_error'),
    last_attempted_at: timestamp('last_attempted_at', { withTimezone: true }),

    // Null while outstanding. Set when the retry succeeded, or when the drain
    // established there was nothing left to do — a booking cancelled since,
    // a payment whose settlement another path already recorded.
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdx: index('ledger_outbox_tenant_idx').on(table.tenant_id),
    // The drain's query: outstanding entries, oldest first.
    pendingIdx: index('ledger_outbox_pending_idx').on(
      table.tenant_id,
      table.resolved_at,
      table.created_at
    ),
    subjectIdx: index('ledger_outbox_subject_idx').on(
      table.operation,
      table.subject_id
    ),

    // One entry per operation per subject. A booking that fails to accrue on
    // every one of five retries is one problem, and five rows describing it
    // would be five things for somebody to work through. The writer upserts
    // onto this.
    //
    // Deliberately NOT partial on resolved_at: an entry that resolved and
    // later failed again reuses the row and its attempt count, which is the
    // history worth keeping. Nothing is lost — resolved_at simply goes back to
    // null.
    subjectUnique: unique('ledger_outbox_operation_subject_key').on(
      table.tenant_id,
      table.operation,
      table.subject_id
    ),

    tenantFk: foreignKey({
      columns: [table.tenant_id],
      foreignColumns: [tenants.id],
      name: 'ledger_outbox_tenant_fk',
    }),
  })
);
