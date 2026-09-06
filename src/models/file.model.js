// src/db/schema/files.schema.js
import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { user } from './user.model.js';

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileId: text('file_id').notNull().unique(), // ImageKit file ID
  fileName: text('file_name').notNull(),
  originalName: text('original_name').notNull(),
  url: text('url').notNull(),
  thumbnailUrl: text('thumbnail_url'),
  folder: text('folder').notNull(),
  fileType: text('file_type').notNull(), // image, video, etc.
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(), // in bytes
  width: integer('width'),
  height: integer('height'),
  tags: jsonb('tags').default([]),
  metadata: jsonb('metadata').default({}),
  uploadedBy: text('uploaded_by').references(() => user.id, {
    onDelete: 'set null',
  }), // FK to users table
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const filesRelations = relations(files, ({ one }) => ({
  uploader: one(user, {
    fields: [files.uploadedBy],
    references: [user.id],
  }),
}));
