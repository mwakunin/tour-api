// src/models/blog.model.js
import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { user } from './user.model.js';

// ============================================
// ENUMS
// ============================================

// Enum for post status
export const postStatusEnum = pgEnum('post_status', ['draft', 'published']);

// ============================================
// BLOG CATEGORIES TABLE
// ============================================

export const blogCategories = pgTable('blog_categories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  description: text('description'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================
// BLOG POSTS TABLE
// ============================================

export const blogPosts = pgTable('blog_posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  excerpt: text('excerpt').notNull(),
  content: text('content').notNull(),
  featured_image: varchar('featured_image', { length: 500 }),

  // Foreign keys
  category_id: integer('category_id').references(() => blogCategories.id, {
    onDelete: 'set null',
  }),
  author_id: text('author_id').references(() => user.id, { onDelete: 'set null' }),

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
});
