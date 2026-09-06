// src/validations/upload.validation.js
import { z } from 'zod';

export const uploadSingleSchema = z.object({
  body: z.object({
    folder: z
      .string()
      .max(50, 'Folder name too long')
      .regex(/^[a-z0-9-_]+$/, 'Invalid folder name format')
      .optional()
      .default('general'),

    tags: z
      .string()
      .optional()
      .transform((val) => val?.split(',').map((t) => t.trim()) || []),
  }),
});

export const uploadMultipleSchema = z.object({
  body: z.object({
    folder: z
      .string()
      .max(50, 'Folder name too long')
      .regex(/^[a-z0-9-_]+$/, 'Invalid folder name format')
      .optional()
      .default('general'),

    tags: z
      .string()
      .optional()
      .transform((val) => val?.split(',').map((t) => t.trim()) || []),
  }),
});

export const deleteFileSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid file ID'),
  }),
});

export const getOptimizedImageSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid file ID'),
  }),
  query: z.object({
    // Coerced then validated, rather than parseInt'd and trusted: NaN,
    // negatives and absurd dimensions all reached ImageKit before.
    width: z.coerce.number().int().positive().max(5000).default(800),
    height: z.coerce.number().int().positive().max(5000).default(600),
    quality: z.coerce.number().int().min(1).max(100).default(80),
    format: z
      .enum(['auto', 'webp', 'jpg', 'png', 'avif'])
      .optional()
      .default('auto'),
  }),
});

export const fileResponseSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string(),
  fileName: z.string(),
  originalName: z.string(),
  url: z.string().url(),
  thumbnailUrl: z.string().url().nullable(),
  folder: z.string(),
  fileType: z.string(),
  size: z.number(),
  tags: z.array(z.string()),
  createdAt: z.date(),
});
