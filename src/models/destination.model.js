import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tourDestinations } from './tour.model.js';
import { tenants } from './tenant.model.js';

// ============= DESTINATIONS TABLE =============
export const destinations = pgTable(
  'destinations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Tenant discriminator. Added before there is a second operator on
    // purpose — retrofitting this across every table and query later is the
    // expensive migration, and the column costs nothing while there is one row.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    // Core fields
    title: text('title').notNull(),
    slug: varchar('slug', { length: 250 }).notNull(),
    description: text('description').notNull(),

    // Media
    image: text('image').notNull(),

    // Location
    country: text('country').notNull(),
    region: text('region'),

    // Display options
    featured: boolean('featured').default(false).notNull(),
    position: integer('position').default(0).notNull(), // For custom ordering

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
    tenantIdIdx: index('destinations_tenant_id_idx').on(table.tenant_id),
    tenantScopedId: unique('destinations_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    tenantSlugUnique: unique('destinations_tenant_id_slug_key').on(
      table.tenant_id,
      table.slug
    ),
    // Indexes for better query performance
    slugIdx: index('destinations_slug_idx').on(table.slug),
    countryIdx: index('destinations_country_idx').on(table.country),
    featuredIdx: index('destinations_featured_idx').on(table.featured),
  })
);

// ✅ ONLY CHANGE - Update relation
export const destinationsRelations = relations(destinations, ({ many }) => ({
  tourDestinations: many(tourDestinations),
}));
