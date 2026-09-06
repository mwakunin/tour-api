// src/validations/blog.validation.js
import { z } from 'zod';

// Create Blog Post
export const createBlogPostSchema = z.object({
  title: z
    .string()
    .min(10, 'Title must be at least 10 characters')
    .max(255, 'Title must not exceed 255 characters'),

  slug: z
    .string()
    .min(5, 'Slug must be at least 5 characters')
    .max(255, 'Slug must not exceed 255 characters')
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug must be lowercase with hyphens only'
    )
    .optional(), // Auto-generated if not provided

  excerpt: z
    .string()
    .min(50, 'Excerpt must be at least 50 characters')
    .max(500, 'Excerpt must not exceed 500 characters'),

  content: z.string().min(100, 'Content must be at least 100 characters'),

  featured_image: z
    .string()
    .url('Featured image must be a valid URL')
    .optional()
    .nullable(),

  category_id: z
    .number()
    .int()
    .positive('Category ID must be a positive integer')
    .optional()
    .nullable(),

  status: z.enum(['draft', 'published']).default('draft'),

  meta_title: z
    .string()
    .max(60, 'Meta title must not exceed 60 characters')
    .optional()
    .nullable(),

  meta_description: z
    .string()
    .max(160, 'Meta description must not exceed 160 characters')
    .optional()
    .nullable(),

  read_time_minutes: z.number().int().positive().max(120).optional().nullable(),

  published_at: z.string().datetime().optional().nullable(),
});

// Update Blog Post
export const updateBlogPostSchema = z.object({
  title: z.string().min(10).max(255).optional(),

  slug: z
    .string()
    .min(5)
    .max(255)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),

  excerpt: z.string().min(50).max(500).optional(),

  content: z.string().min(100).optional(),

  featured_image: z.string().url().optional().nullable(),

  category_id: z.number().int().positive().optional().nullable(),

  status: z.enum(['draft', 'published']).optional(),

  meta_title: z.string().max(60).optional().nullable(),

  meta_description: z.string().max(160).optional().nullable(),

  read_time_minutes: z.number().int().positive().max(120).optional().nullable(),

  published_at: z.string().datetime().optional().nullable(),
});

// Create Blog Category
export const createBlogCategorySchema = z.object({
  name: z
    .string()
    .min(2, 'Category name must be at least 2 characters')
    .max(100, 'Category name must not exceed 100 characters'),

  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),

  description: z.string().max(500).optional().nullable(),
});

// Update Blog Category
export const updateBlogCategorySchema = z.object({
  name: z.string().min(2).max(100).optional(),

  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),

  description: z.string().max(500).optional().nullable(),
});

// Query Parameters Validation
export const getBlogPostsQuerySchema = z.object({
  page: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('1'),

  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(100))
    .default('10'),

  status: z.enum(['draft', 'published', 'all']).optional().default('published'),

  category_id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().positive())
    .optional(),

  search: z.string().max(255).optional(),

  sort_by: z
    .enum(['created_at', 'published_at', 'title', 'read_time_minutes'])
    .optional()
    .default('published_at'),

  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
});
