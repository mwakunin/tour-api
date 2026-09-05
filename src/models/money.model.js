// src/models/money.model.js
//
// THE MONEY LAYER
//
// One module, six tables, deliberately ignorant of tours. There is no
// booking_id, no lodge, no itinerary in here — the vocabulary is
// counterparty / obligation / settlement / allocation so the same module can
// carry supplier payables and agent commissions in this product and fee
// arrears and unmatched Paybill receipts in school-saas.
//
// The shape that makes it port:
//
//   obligation   money owed, either direction, with a due date
//   settlement   money that actually moved
//   allocation   which settlement satisfied which obligation
//
// Partial payments, deposits, overpayments, arrears, and an M-Pesa receipt
// with a mangled account reference that a human has to match by hand are all
// the same operation: attaching a settlement to an obligation. That is why
// `allocations` is the centre of gravity and not an afterthought.
//
// CONVENTIONS
//
// * Money is integer cents in a bigint, never a float and never numeric.
//   KES amounts are two orders of magnitude larger than USD ones, so a plain
//   integer runs out sooner than is comfortable — bigint costs nothing here.
// * Balances are DERIVED (sum of obligations minus sum of allocations), never
//   stored. `obligations.status` is lifecycle only: open / void / written_off.
//   Whether something is settled is a query, so it cannot drift.
// * Child rows reference (tenant_id, id), not (id). Postgres validates a
//   foreign key internally and would happily let a row point at another
//   tenant's parent; the composite key makes that fail at the constraint.

import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  boolean,
  date,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { tenants } from './tenant.model.js';
import { payments, paymentMethodEnum } from './payment.model.js';
import {
  currencyEnum,
  counterpartyTypeEnum,
  obligationDirectionEnum,
  obligationKindEnum,
  obligationStatusEnum,
  settlementDirectionEnum,
  settlementStatusEnum,
  ledgerAccountEnum,
} from './enums.model.js';

// ============= COUNTERPARTIES =============
// Anyone money moves to or from, other than the tenant: the customer paying a
// balance, the lodge invoicing a deposit, the agent owed commission, the park
// authority taking fees.

export const counterparties = pgTable(
  'counterparties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    type: counterpartyTypeEnum('type').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),

    // Currency this counterparty is normally billed or paid in. Safari lodges
    // quote USD, guides and park fees are KES, and the same operator deals in
    // both on a single itinerary.
    default_currency: currencyEnum('default_currency').default('KES').notNull(),

    // Net payment terms for suppliers, in days from invoice date.
    payment_terms_days: integer('payment_terms_days'),

    // Agent commission, in basis points — integer, because a commission rate
    // multiplied by money must not go anywhere near a float. 1250 = 12.5%.
    commission_rate_bps: integer('commission_rate_bps'),

    // Where an outbound settlement to this counterparty goes.
    mpesa_number: text('mpesa_number'),
    bank_details: text('bank_details'),

    notes: text('notes'),
    is_active: boolean('is_active').default(true).notNull(),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdIdx: index('counterparties_tenant_id_idx').on(table.tenant_id),
    typeIdx: index('counterparties_tenant_type_idx').on(
      table.tenant_id,
      table.type
    ),
    nameIdx: index('counterparties_name_idx').on(table.name),
    // Target for the composite foreign keys below.
    tenantScopedId: unique('counterparties_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    commissionRangeCk: check(
      'counterparties_commission_rate_bps_range',
      sql`${table.commission_rate_bps} IS NULL OR (${table.commission_rate_bps} >= 0 AND ${table.commission_rate_bps} <= 10000)`
    ),
  })
);

// ============= OBLIGATIONS =============
// Money owed, in either direction, with a date it falls due. A booking creates
// a receivable for the deposit and another for the balance; a lodge invoice
// creates a payable; an agent's cut creates a payable.

export const obligations = pgTable(
  'obligations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    direction: obligationDirectionEnum('direction').notNull(),
    kind: obligationKindEnum('kind').notNull(),

    counterparty_id: uuid('counterparty_id'),

    // Polymorphic backlink to whatever produced this obligation — 'booking',
    // 'supplier_invoice', 'commission'. Deliberately not a foreign key and
    // deliberately not an enum: this is the seam where the portable module
    // meets a specific product, and school-saas will put 'fee_invoice' here.
    // The cost is that the database cannot enforce it; the benefit is that the
    // module does not import a single tour table.
    source_type: text('source_type'),
    source_id: uuid('source_id'),

    amount_cents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull(),

    due_on: date('due_on'),

    // Lifecycle only — NOT settlement state. An obligation is settled when its
    // allocations cover it, which is a query against `allocations`.
    status: obligationStatusEnum('status').default('open').notNull(),

    description: text('description'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdIdx: index('obligations_tenant_id_idx').on(table.tenant_id),
    counterpartyIdx: index('obligations_counterparty_idx').on(
      table.counterparty_id
    ),
    sourceIdx: index('obligations_source_idx').on(
      table.source_type,
      table.source_id
    ),
    // The ageing / "what is due this week" query.
    dueIdx: index('obligations_tenant_direction_due_idx').on(
      table.tenant_id,
      table.direction,
      table.due_on
    ),
    tenantScopedId: unique('obligations_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    counterpartyFk: foreignKey({
      name: 'obligations_counterparty_tenant_fk',
      columns: [table.tenant_id, table.counterparty_id],
      foreignColumns: [counterparties.tenant_id, counterparties.id],
    }).onDelete('restrict'),
    amountPositiveCk: check(
      'obligations_amount_cents_positive',
      sql`${table.amount_cents} > 0`
    ),
  })
);

// ============= SETTLEMENTS =============
// Money that actually moved. Inbound settlements from the existing checkout
// flow point back at `payments`, which keeps every provider-specific column —
// M-Pesa receipt numbers, Pesapal tracking ids — out of the portable module.
// Outbound settlements (a lodge deposit, an agent payout) have no payment row.

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    direction: settlementDirectionEnum('direction').notNull(),
    counterparty_id: uuid('counterparty_id'),

    method: paymentMethodEnum('method').notNull(),
    amount_cents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull(),

    // Provider-agnostic reference: an M-Pesa receipt, a bank slip number, a
    // Pesapal tracking id. Indexed because reconciling a statement means
    // looking money up by whatever reference the bank or telco printed.
    external_reference: text('external_reference'),

    // Set for inbound settlements that came through the checkout.
    payment_id: uuid('payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),

    status: settlementStatusEnum('status').default('pending').notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }),

    notes: text('notes'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdIdx: index('settlements_tenant_id_idx').on(table.tenant_id),
    counterpartyIdx: index('settlements_counterparty_idx').on(
      table.counterparty_id
    ),
    externalRefIdx: index('settlements_external_reference_idx').on(
      table.external_reference
    ),
    paymentIdx: index('settlements_payment_id_idx').on(table.payment_id),
    // "Money that arrived but is not yet matched to anything" — the
    // unallocated-receipts worklist.
    occurredIdx: index('settlements_tenant_direction_occurred_idx').on(
      table.tenant_id,
      table.direction,
      table.occurred_at
    ),
    tenantScopedId: unique('settlements_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    counterpartyFk: foreignKey({
      name: 'settlements_counterparty_tenant_fk',
      columns: [table.tenant_id, table.counterparty_id],
      foreignColumns: [counterparties.tenant_id, counterparties.id],
    }).onDelete('restrict'),
    amountPositiveCk: check(
      'settlements_amount_cents_positive',
      sql`${table.amount_cents} > 0`
    ),
  })
);

// ============= ALLOCATIONS =============
// The join that makes reconciliation a query instead of a spreadsheet. One row
// says "this much of this settlement satisfied this obligation".
//
// Two invariants the database cannot express, enforced in the service layer
// and covered by tests: an allocation must join same-currency rows, and
// directions must agree (receivable <- in, payable <- out). Both are
// candidates for a trigger if they ever get violated in practice.

export const allocations = pgTable(
  'allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    obligation_id: uuid('obligation_id').notNull(),
    settlement_id: uuid('settlement_id').notNull(),

    amount_cents: bigint('amount_cents', { mode: 'number' }).notNull(),

    note: text('note'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdIdx: index('allocations_tenant_id_idx').on(table.tenant_id),
    obligationIdx: index('allocations_obligation_idx').on(table.obligation_id),
    settlementIdx: index('allocations_settlement_idx').on(table.settlement_id),
    // One row per pair; a correction updates the amount rather than stacking
    // rows, which keeps "how much of this settlement is spent" a simple sum.
    pairUnique: unique('allocations_obligation_settlement_key').on(
      table.obligation_id,
      table.settlement_id
    ),
    obligationFk: foreignKey({
      name: 'allocations_obligation_tenant_fk',
      columns: [table.tenant_id, table.obligation_id],
      foreignColumns: [obligations.tenant_id, obligations.id],
    }).onDelete('cascade'),
    settlementFk: foreignKey({
      name: 'allocations_settlement_tenant_fk',
      columns: [table.tenant_id, table.settlement_id],
      foreignColumns: [settlements.tenant_id, settlements.id],
    }).onDelete('cascade'),
    amountPositiveCk: check(
      'allocations_amount_cents_positive',
      sql`${table.amount_cents} > 0`
    ),
  })
);

// ============= FX RATES =============
// Rate captured as integer parts-per-million, for the same reason money is
// cents: no floats anywhere near the books. USD->KES 129.45 stores as
// 129_450_000. A null tenant_id is a shared/reference rate.

export const fx_rates = pgTable(
  'fx_rates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),

    base_currency: currencyEnum('base_currency').notNull(),
    quote_currency: currencyEnum('quote_currency').notNull(),

    rate_ppm: bigint('rate_ppm', { mode: 'number' }).notNull(),
    as_of: date('as_of').notNull(),

    source: varchar('source', { length: 64 }),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    lookupIdx: index('fx_rates_lookup_idx').on(
      table.tenant_id,
      table.base_currency,
      table.quote_currency,
      table.as_of
    ),
    ratePositiveCk: check(
      'fx_rates_rate_ppm_positive',
      sql`${table.rate_ppm} > 0`
    ),
    differentCurrenciesCk: check(
      'fx_rates_currencies_differ',
      sql`${table.base_currency} <> ${table.quote_currency}`
    ),
  })
);

// ============= LEDGER ENTRIES =============
// Double-entry, one row per leg. `amount_cents` is signed: positive debits,
// negative credits.
//
// Every leg is booked twice — once in the currency the money actually moved in
// (`amount_cents` / `currency`) and once converted into the tenant's base
// currency (`base_amount_cents`). The invariant is on the base amount:
//
//   SELECT entry_group_id FROM ledger_entries
//   GROUP BY entry_group_id HAVING sum(base_amount_cents) <> 0;
//
// must return nothing. Booking in transaction currency and balancing in base
// currency is what lets a USD lodge invoice and a KES park fee sit in one
// entry group without the books drifting; the residue goes to fx_gain_loss.
//
// These rows are written in the SAME transaction as the settlement or
// obligation they describe. That is the whole reason the money layer lives in
// this database rather than behind an API — a ledger that can disagree with
// the thing it accounts for is worse than no ledger.

export const ledger_entries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    // Groups the legs of one transaction. Not a foreign key — the group has no
    // row of its own, it is just the balancing unit.
    entry_group_id: uuid('entry_group_id').notNull(),

    account: ledgerAccountEnum('account').notNull(),

    amount_cents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull(),

    base_amount_cents: bigint('base_amount_cents', {
      mode: 'number',
    }).notNull(),
    fx_rate_id: uuid('fx_rate_id').references(() => fx_rates.id, {
      onDelete: 'set null',
    }),

    occurred_at: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),

    // Same polymorphic seam as obligations: 'settlement', 'obligation',
    // 'allocation', or a product-specific noun.
    source_type: text('source_type'),
    source_id: uuid('source_id'),

    memo: text('memo'),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdIdx: index('ledger_entries_tenant_id_idx').on(table.tenant_id),
    groupIdx: index('ledger_entries_group_idx').on(table.entry_group_id),
    // The trial-balance / account-statement query.
    accountIdx: index('ledger_entries_tenant_account_occurred_idx').on(
      table.tenant_id,
      table.account,
      table.occurred_at
    ),
    sourceIdx: index('ledger_entries_source_idx').on(
      table.source_type,
      table.source_id
    ),
    // A zero-value leg is always a bug in the code that wrote it.
    amountNonZeroCk: check(
      'ledger_entries_amount_cents_non_zero',
      sql`${table.amount_cents} <> 0`
    ),
  })
);

// ============= RELATIONS =============

export const tenantsRelations = relations(tenants, ({ many }) => ({
  counterparties: many(counterparties),
  obligations: many(obligations),
  settlements: many(settlements),
  allocations: many(allocations),
  ledgerEntries: many(ledger_entries),
}));

export const counterpartiesRelations = relations(
  counterparties,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [counterparties.tenant_id],
      references: [tenants.id],
    }),
    obligations: many(obligations),
    settlements: many(settlements),
  })
);

export const obligationsRelations = relations(obligations, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [obligations.tenant_id],
    references: [tenants.id],
  }),
  counterparty: one(counterparties, {
    fields: [obligations.counterparty_id],
    references: [counterparties.id],
  }),
  allocations: many(allocations),
}));

export const settlementsRelations = relations(settlements, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [settlements.tenant_id],
    references: [tenants.id],
  }),
  counterparty: one(counterparties, {
    fields: [settlements.counterparty_id],
    references: [counterparties.id],
  }),
  payment: one(payments, {
    fields: [settlements.payment_id],
    references: [payments.id],
  }),
  allocations: many(allocations),
}));

export const allocationsRelations = relations(allocations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [allocations.tenant_id],
    references: [tenants.id],
  }),
  obligation: one(obligations, {
    fields: [allocations.obligation_id],
    references: [obligations.id],
  }),
  settlement: one(settlements, {
    fields: [allocations.settlement_id],
    references: [settlements.id],
  }),
}));

export const ledgerEntriesRelations = relations(ledger_entries, ({ one }) => ({
  tenant: one(tenants, {
    fields: [ledger_entries.tenant_id],
    references: [tenants.id],
  }),
  fxRate: one(fx_rates, {
    fields: [ledger_entries.fx_rate_id],
    references: [fx_rates.id],
  }),
}));
