// src/models/supplierInvoice.model.js
//
// What a supplier sent us. The money layer already knows how to owe somebody
// money — that is an obligation — so this table deliberately does not repeat
// it. It holds the facts that belong to the document and nothing else:
//
//   the supplier's own invoice number, so a statement can be reconciled
//   the date they issued it, which is what payment terms count from
//   whatever note the operator wants against it
//
// The amount, the currency, the due date and whether it is still outstanding
// all live on the obligation raised alongside it, reachable through
// (source_type, source_id). Storing the amount here as well would create two
// records of the same number with nothing keeping them equal, and the one the
// ledger uses would not be the one anybody reads.
//
// That is also why there is no status column. An invoice is paid when its
// obligation has nothing outstanding, and outstanding is derived from
// allocations rather than stored — so it cannot drift out of agreement with
// the money that actually moved.

import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenant.model.js';
import { counterparties } from './money.model.js';
import { bookings } from './booking.model.js';

export const supplierInvoices = pgTable(
  'supplier_invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    counterparty_id: uuid('counterparty_id').notNull(),

    // The supplier's reference, not ours. This is the string on their
    // statement, and matching it is the whole point of recording it.
    invoice_number: text('invoice_number').notNull(),

    // When the supplier issued it. Payment terms count from here, not from
    // when somebody got round to entering it.
    issued_on: date('issued_on').notNull(),

    // Which trip this cost belongs to, when it belongs to one. A lodge
    // invoice for a specific safari is attributable; a monthly insurance
    // premium is not, and stays null rather than being forced onto a booking
    // it does not belong to.
    //
    // Nullable and ON DELETE SET NULL: the debt is real whether or not the
    // booking it was attributed to still exists, so losing the attribution
    // must not take the invoice with it.
    booking_id: uuid('booking_id'),

    notes: text('notes'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdIdx: index('supplier_invoices_tenant_id_idx').on(table.tenant_id),
    counterpartyIdx: index('supplier_invoices_counterparty_idx').on(
      table.tenant_id,
      table.counterparty_id
    ),
    issuedOnIdx: index('supplier_invoices_issued_on_idx').on(
      table.tenant_id,
      table.issued_on
    ),

    // A supplier does not issue the same number twice. Scoped to the supplier
    // rather than the tenant, because two lodges both numbering from 001 is
    // ordinary and neither is wrong.
    numberPerSupplier: unique('supplier_invoices_number_per_supplier').on(
      table.tenant_id,
      table.counterparty_id,
      table.invoice_number
    ),

    // Composite, like every other cross-table reference here: a single-column
    // reference would let one tenant's invoice point at another tenant's
    // supplier, and Postgres would validate it internally without complaint.
    counterpartyFk: foreignKey({
      name: 'supplier_invoices_counterparty_tenant_fk',
      columns: [table.tenant_id, table.counterparty_id],
      foreignColumns: [counterparties.tenant_id, counterparties.id],
    }).onDelete('restrict'),

    // Safe to declare here: this file imports booking.model.js and nothing in
    // that direction imports back, so there is no cycle. bookings cannot
    // reference counterparties the same way for exactly that reason — see the
    // note on bookings.agent_id.
    //
    // DELIBERATE DIVERGENCE FROM THE DATABASE. Drizzle emits a plain
    // ON DELETE SET NULL, which over a composite key nulls *every* column in
    // it — including tenant_id, which is NOT NULL, so deleting an attributed
    // booking fails rather than clearing the attribution. Migration 0024
    // rewrites this as the column-scoped `SET NULL (booking_id)` that Postgres
    // 15+ supports and Drizzle cannot express, exactly as 0007 does for
    // blog_posts_category_tenant_fk. Do not "fix" the divergence by
    // regenerating the constraint.
    bookingFk: foreignKey({
      name: 'supplier_invoices_booking_tenant_fk',
      columns: [table.tenant_id, table.booking_id],
      foreignColumns: [bookings.tenant_id, bookings.id],
    }).onDelete('set null'),

    bookingIdx: index('supplier_invoices_booking_idx').on(
      table.tenant_id,
      table.booking_id
    ),
  })
);

export const supplierInvoicesRelations = relations(
  supplierInvoices,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [supplierInvoices.tenant_id],
      references: [tenants.id],
    }),
    booking: one(bookings, {
      fields: [supplierInvoices.booking_id],
      references: [bookings.id],
    }),
    counterparty: one(counterparties, {
      fields: [supplierInvoices.counterparty_id],
      references: [counterparties.id],
    }),
  })
);
