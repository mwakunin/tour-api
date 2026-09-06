// src/models/tenant.model.js
//
// The tenancy primitive. One row per tour operator.
//
// Deliberately minimal for now: the *data model* is tenant-aware from day one
// because retrofitting a discriminator across every table and query later is
// brutal, but the *tenancy product* — signup, provisioning, subdomains,
// billing, a tenant switcher — is not built yet. Footloose runs as a single
// seeded row and nothing user-facing says the word "tenant".

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import {
  currencyEnum,
  tenantStatusEnum,
  mpesaShortcodeTypeEnum,
} from './enums.model.js';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    name: text('name').notNull(),
    // Used for subdomain routing when the tenancy product lands.
    slug: varchar('slug', { length: 63 }).notNull().unique(),

    // Reporting currency. Every ledger entry also carries a base_amount_cents
    // converted into this, which is what makes cross-currency books balance.
    base_currency: currencyEnum('base_currency').default('KES').notNull(),

    // Was the BOOKING_REF_PREFIX env var. Operator identity is configuration,
    // not deployment — see the branding note in CLAUDE.md.
    booking_ref_prefix: varchar('booking_ref_prefix', { length: 8 })
      .default('FA')
      .notNull(),

    // Per-tenant M-Pesa / Pesapal credentials. Customer money settles directly
    // into the operator's own shortcode and NEVER routes through our account —
    // that is what keeps this product outside CBK payment-service licensing.
    // Encrypted at rest; never select these into a response.
    mpesa_shortcode: text('mpesa_shortcode'),
    // Selects the Daraja transaction type; see the enum for why it is per
    // tenant rather than a deployment constant.
    mpesa_shortcode_type: mpesaShortcodeTypeEnum('mpesa_shortcode_type')
      .default('paybill')
      .notNull(),
    mpesa_credentials: text('mpesa_credentials'),
    pesapal_credentials: text('pesapal_credentials'),

    status: tenantStatusEnum('status').default('active').notNull(),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    slugIdx: index('tenants_slug_idx').on(table.slug),
    statusIdx: index('tenants_status_idx').on(table.status),
  })
);
