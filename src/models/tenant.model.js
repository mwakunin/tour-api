// src/models/tenant.model.js
//
// The tenancy primitive. One row per tour operator.
//
// Deliberately minimal for now: the *data model* is tenant-aware from day one
// because retrofitting a discriminator across every table and query later is
// brutal, but the *tenancy product* — signup, provisioning, subdomains,
// billing, a tenant switcher — is not built yet. Footloose runs as a single
// seeded row and nothing user-facing says the word "tenant".

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  index,
  check,
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

    // Where operator notifications go: the daily booking summary and the
    // new-booking alert. Was the deployment-wide ADMIN_EMAIL, which across
    // tenants meant one operator's booking totals and revenue were emailed to
    // whichever address the deployment happened to name — the query was tenant
    // scoped but the recipient was not.
    //
    // Nullable on purpose: callers fall back to the env var, so the seeded
    // tenant and any pre-tenancy deployment keep working until an operator
    // sets its own.
    admin_email: text('admin_email'),

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

    // DEPOSIT POLICY. Null means no schedule: a booking raises one
    // receivable for the full amount, which is what every operator does today
    // and what this did before the columns existed.
    //
    // Basis points, like counterparties.commission_rate_bps, so a 30% deposit
    // is 3000 and the split is integer arithmetic end to end. A percentage
    // stored as a decimal would put a float between a customer and what they
    // are asked to pay.
    //
    // There is no endpoint to set this. Deposit terms are operator
    // configuration and the tenancy product that would own that screen is not
    // built, so it is an owner-plane UPDATE for now — deliberately, rather
    // than shipping a number nobody chose as a default.
    deposit_percent_bps: integer('deposit_percent_bps'),

    // How many days before departure the balance falls due. Null with a
    // deposit set means the balance is due on the departure date itself.
    balance_due_days_before_departure: integer(
      'balance_due_days_before_departure'
    ),

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

    // The column exists for subdomain routing, so its values have to be
    // things a subdomain can be: one DNS label, lowercase, no leading or
    // trailing hyphen. Without this, varchar(63) NOT NULL UNIQUE happily
    // accepts `foo.bar`, and a host foo.bar.<suffix> would resolve to it —
    // the middleware refuses that host before it queries, and this is why it
    // cannot come back through another door.
    slugIsDnsLabelCk: check(
      'tenants_slug_dns_label',
      sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`
    ),

    // No endpoint sets the deposit policy, so these constraints are not a
    // second opinion about what validation already checked — they are the only
    // check there is, and the operator writing the UPDATE by hand is exactly
    // who they are for.
    //
    // Open interval on purpose. 0 bps is "no deposit", which is what NULL
    // already means, and 10000 bps is the whole booking, which leaves a
    // zero-cent balance leg that assertAmountCents rejects. Both are spelled
    // by leaving the column NULL.
    depositRangeCk: check(
      'tenants_deposit_percent_bps_range',
      sql`${table.deposit_percent_bps} IS NULL OR (${table.deposit_percent_bps} > 0 AND ${table.deposit_percent_bps} < 10000)`
    ),
    balanceDaysCk: check(
      'tenants_balance_due_days_non_negative',
      sql`${table.balance_due_days_before_departure} IS NULL OR ${table.balance_due_days_before_departure} >= 0`
    ),
    // A balance date with no deposit percentage is a half-written policy: it
    // says when the balance falls due without saying what the balance is.
    // Rejected rather than ignored, because ignoring it looks like it worked.
    balanceNeedsDepositCk: check(
      'tenants_balance_days_needs_deposit',
      sql`${table.balance_due_days_before_departure} IS NULL OR ${table.deposit_percent_bps} IS NOT NULL`
    ),
  })
);
