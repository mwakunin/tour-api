import { z } from 'zod';

// ============= COMMON SCHEMAS =============
export const uuidParamSchema = z.object({
  id: z.string().uuid('Invalid ID format'),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

export const sortSchema = z.object({
  sort_by: z.string().optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const dateRangeSchema = z
  .object({
    start_date: z.coerce.date().optional(),
    end_date: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return data.end_date >= data.start_date;
      }
      return true;
    },
    {
      message: 'End date must be after or equal to start date',
      path: ['end_date'],
    }
  );

// Common field validators
export const emailSchema = z.string().email('Invalid email address').max(255);
export const phoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number');
export const urlSchema = z.string().url('Must be a valid URL');
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens');
export const booleanQueryParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((val) => (val === undefined ? undefined : val === 'true'));
