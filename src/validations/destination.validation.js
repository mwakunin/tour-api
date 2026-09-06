// src/validations/destination.validation.js
import { z } from 'zod';
import { slugSchema, urlSchema, booleanQueryParam } from './common.js';

/**
 * Base destination schema
 */
export const destinationSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1, 'Title is required').max(200),
  slug: slugSchema,
  description: z
    .string()
    .min(50, 'Description must be at least 50 characters')
    .max(2000),
  image: urlSchema,
  country: z.string().min(1, 'Country is required').max(100),
  region: z.string().max(100).optional(),
  featured: z.boolean().default(false),
  position: z.number().int().min(0).default(0).optional(),
  meta_title: z.string().max(60).optional(),
  meta_description: z.string().max(160).optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});

/**
 * Schema for creating a destination
 */
export const destinationCreateSchema = destinationSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

/**
 * Schema for updating a destination
 */
// The create schema defaults `featured` and `position`, and .partial() keeps
// those defaults — so a PATCH that never mentioned either silently reset them
// to the create-time values.
//
// Both are omitted and redeclared rather than unwrapped with removeDefault():
// `position` is `.default(0).optional()`, so its outer wrapper is optional and
// removeDefault does not exist on it. Declaring them plainly avoids depending
// on the internal wrapper order at all.
export const destinationUpdateSchema = destinationSchema
  .omit({
    id: true,
    created_at: true,
    updated_at: true,
    featured: true,
    position: true,
  })
  .partial()
  .extend({
    featured: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  });

/**
 * Schema for querying destinations
 */
export const destinationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  country: z.string().optional(),
  region: z.string().optional(),
  featured: booleanQueryParam,
  search: z.string().max(200).optional(),
  sort_by: z.enum(['created_at', 'title', 'country']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Validation helpers
 */
export const validateDestination = (data) =>
  destinationCreateSchema.parse(data);
export const validateDestinationUpdate = (data) =>
  destinationUpdateSchema.parse(data);
export const validateDestinationQuery = (data) =>
  destinationQuerySchema.parse(data);
