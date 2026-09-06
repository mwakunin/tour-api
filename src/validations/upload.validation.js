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
    width: z
      .string()
      .optional()
      .transform((val) => parseInt(val || '800')),
    height: z
      .string()
      .optional()
      .transform((val) => parseInt(val || '600')),
    quality: z
      .string()
      .optional()
      .transform((val) => parseInt(val || '80')),
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
