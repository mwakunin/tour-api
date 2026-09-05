// src/models/blog.model.js
import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  pgEnum,
  index,
  unique,
  foreignKey,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './user.model.js';
import { tenants } from './tenant.model.js';

// ============================================
// ENUMS
// ============================================

// Enum for post status
export const postStatusEnum = pgEnum('post_status', ['draft', 'published']);

// ============================================
// BLOG CATEGORIES TABLE
// ============================================

export const blogCategories = pgTable(
  'blog_categories',
  {
    id: serial('id').primaryKey(),
    // Tenant discriminator — see the note in tour.model.js.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: text('description'),
    created_at: timestamp('created_at').defaultNow().notNull(),
    updated_at: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    tenantIdIdx: index('blog_categories_tenant_id_idx').on(table.tenant_id),
    tenantScopedId: unique('blog_categories_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
    tenantSlugUnique: unique('blog_categories_tenant_id_slug_key').on(
      table.tenant_id,
      table.slug
    ),
  })
);

// ============================================
// BLOG POSTS TABLE
// ============================================

export const blogPosts = pgTable(
  'blog_posts',
  {
    id: serial('id').primaryKey(),
    // Tenant discriminator — see the note in tour.model.js.
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull(),
    excerpt: text('excerpt').notNull(),
    content: text('content').notNull(),
    featured_image: varchar('featured_image', { length: 500 }),

    // Foreign keys
    category_id: integer('category_id').references(() => blogCategories.id, {
      onDelete: 'set null',
    }),
    author_id: text('author_id').references(() => user.id, {
      onDelete: 'set null',
    }),

    // Status
    status: postStatusEnum('status').default('draft').notNull(),

    // SEO fields
    meta_title: varchar('meta_title', { length: 60 }),
    meta_description: text('meta_description'),

    // Additional info
    read_time_minutes: integer('read_time_minutes'),
    views_count: integer('views_count').default(0).notNull(),

    // Timestamps
    published_at: timestamp('published_at'),
    created_at: timestamp('created_at').defaultNow().notNull(),
    updated_at: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    tenantIdIdx: index('blog_posts_tenant_id_idx').on(table.tenant_id),
    tenantSlugUnique: unique('blog_posts_tenant_id_slug_key').on(
      table.tenant_id,
      table.slug
    ),
    categoryFk: foreignKey({
      name: 'blog_posts_category_tenant_fk',
      columns: [table.tenant_id, table.category_id],
      foreignColumns: [blogCategories.tenant_id, blogCategories.id],
    }).onDelete('set null'),
  })
);
