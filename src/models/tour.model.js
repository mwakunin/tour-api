import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  decimal,
  timestamp,
  jsonb,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Import destinations (needed for foreign key reference)
import { destinations } from './destination.model.js';
import { bookings } from './booking.model.js';

// ============= ENUMS =============
import {
  currencyEnum,
  tourStatusEnum,
  durationUnitEnum,
} from './enums.model.js';
import { tenants } from './tenant.model.js';

// ============= TOURS TABLE =============
export const tours = pgTable(
  'tours',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Tenant discriminator. Added before there is a second operator on
    // purpose — retrofitting this across every table and query later is the
    // expensive migration, and the column costs nothing while there is one row.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    // Basic info
    title: text('title').notNull(),
    slug: varchar('slug', { length: 250 }).notNull(),
    overview: text('overview').notNull(),

    // Itinerary
    itinerary: jsonb('itinerary').default(sql`'[]'::jsonb`),

    // Tour details
    duration: integer('duration').notNull(),
    duration_unit: durationUnitEnum('duration_unit').default('days').notNull(),

    // ============= PRICING =============
    // Prices are CHARGED AS ENTERED — nothing multiplies them. compare_at_*
    // is the optional struck-through "was" figure, for display only.
    //
    // Flat base price. Nullable — only used by flat-priced products
    // (transfers, day trips) that have no pricing_periods. Seasonal tours
    // leave these null and price off the period covering the travel date.
    price_amount: decimal('price_amount', {
      precision: 10,
      scale: 2,
    }),
    price_currency: currencyEnum('price_currency'),
    compare_at_amount: decimal('compare_at_amount', {
      precision: 10,
      scale: 2,
    }),
    // DERIVED, not client input: the largest saving across all tiers, written
    // by createTour/updateTour via computeHeadlineDiscount(). Kept as a column
    // so getDeals can filter and sort on it without a JSONB subquery.
    discount_percentage: decimal('discount_percentage', {
      precision: 5,
      scale: 2,
    }).default('0'),

    // Seasonal pricing. Each period owns its own date range and tier table,
    // so a tour can price differently across low/high/festive seasons.
    // Periods must not overlap (enforced in tour.validation.js).
    // Format: [
    //   {
    //     label: 'Festive Season',        // optional
    //     start_date: '2026-12-23',       // day precision, may span years
    //     end_date: '2027-01-02',
    //     pricing_tiers: [
    //       // price_per_person is charged; compare_at_price is the optional
    //       // "was" price shown struck through
    //       { pax: 2, price_per_person: 600, compare_at_price: 800, currency: 'USD' },
    //       { pax: 4, price_per_person: 500, currency: 'USD' },
    //     ],
    //   },
    // ]
    pricing_periods: jsonb('pricing_periods').default(sql`'[]'::jsonb`),

    // Features
    featured: boolean('featured').default(false).notNull(),
    is_deal: boolean('is_deal').default(false).notNull(),

    // Media
    images: jsonb('images')
      .notNull()
      .default(sql`'[]'::jsonb`),
    cover_image: text('cover_image'),

    // What's included/excluded
    includes: jsonb('includes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    excludes: jsonb('excludes')
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Requirements
    requirements: text('requirements'),
    age_restriction: jsonb('age_restriction'),

    // Categorization
    tags: jsonb('tags')
      .notNull()
      .default(sql`'[]'::jsonb`),
    categories: jsonb('categories')
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Status
    status: tourStatusEnum('status').default('draft').notNull(),

    // SEO
    meta_title: varchar('meta_title', { length: 60 }),
    meta_description: varchar('meta_description', { length: 160 }),

    // Timestamps
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },

  (table) => ({
    tenantIdIdx: index('tours_tenant_id_idx').on(table.tenant_id),
    // Target for composite foreign keys from bookings and tour_destinations.
    tenantScopedId: unique('tours_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    // A slug is unique WITHIN an operator, not globally. Two operators both
    // selling a "7-day-mara-safari" is normal; the old global unique forbade it.
    tenantSlugUnique: unique('tours_tenant_id_slug_key').on(
      table.tenant_id,
      table.slug
    ),
    slugIdx: index('tours_slug_idx').on(table.slug),
    statusIdx: index('tours_status_idx').on(table.status),
    featuredIdx: index('tours_featured_idx').on(table.featured),
    isDealIdx: index('tours_is_deal_idx').on(table.is_deal),
    createdAtIdx: index('tours_created_at_idx').on(table.created_at),
    priceIdx: index('tours_price_idx').on(table.price_amount),
    pricingPeriodsIdx: index('tours_pricing_periods_idx').using(
      'gin',
      table.pricing_periods
    ),
  })
);

// ✅ NEW: Junction table for many-to-many relationship
export const tourDestinations = pgTable(
  'tour_destinations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Tenant discriminator. Added before there is a second operator on
    // purpose — retrofitting this across every table and query later is the
    // expensive migration, and the column costs nothing while there is one row.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),
    tour_id: uuid('tour_id')
      .references(() => tours.id, { onDelete: 'cascade' })
      .notNull(),
    destination_id: uuid('destination_id')
      .references(() => destinations.id, { onDelete: 'cascade' })
      .notNull(),
    order: integer('order').default(0), // For ordering destinations
    created_at: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Indexes for the junction table
    tourIdIdx: index('tour_destinations_tour_id_idx').on(table.tour_id),
    destinationIdIdx: index('tour_destinations_destination_id_idx').on(
      table.destination_id
    ),

    // Composite index for queries that filter by both
    tourDestinationIdx: index('tour_destinations_tour_dest_idx').on(
      table.tour_id,
      table.destination_id
    ),
    // Ensure unique tour-destination pairs
    uniqueTourDestination: unique().on(table.tour_id, table.destination_id),
    tenantIdIdx: index('tour_destinations_tenant_id_idx').on(table.tenant_id),
    tourFk: foreignKey({
      name: 'tour_destinations_tour_tenant_fk',
      columns: [table.tenant_id, table.tour_id],
      foreignColumns: [tours.tenant_id, tours.id],
    }).onDelete('cascade'),
    destinationFk: foreignKey({
      name: 'tour_destinations_destination_tenant_fk',
      columns: [table.tenant_id, table.destination_id],
      foreignColumns: [destinations.tenant_id, destinations.id],
    }).onDelete('cascade'),
  })
);

// ============= RELATIONS =============
// Update relations
export const toursRelations = relations(tours, ({ many }) => ({
  tourDestinations: many(tourDestinations),
  bookings: many(bookings),
}));

export const tourDestinationsRelations = relations(
  tourDestinations,
  ({ one }) => ({
    tour: one(tours, {
      fields: [tourDestinations.tour_id],
      references: [tours.id],
    }),
    destination: one(destinations, {
      fields: [tourDestinations.destination_id],
      references: [destinations.id],
    }),
  })
);
// ============= HELPER FUNCTIONS =============

/**
 * Check if tour is available for booking
 */
export const isTourAvailable = (tour) => {
  return tour.status === 'published';
};

/**
 * Get tour duration display
 */
export const getTourDurationDisplay = (tour) => {
  const unit =
    tour.duration === 1
      ? tour.duration_unit.slice(0, -1) // Remove 's' for singular
      : tour.duration_unit;
  return `${tour.duration} ${unit}`;
};
