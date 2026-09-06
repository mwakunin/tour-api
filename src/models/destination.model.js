import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tourDestinations } from './tour.model.js';

// ============= DESTINATIONS TABLE =============
export const destinations = pgTable(
  'destinations',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Core fields
    title: text('title').notNull(),
    slug: varchar('slug', { length: 250 }).notNull().unique(),
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
