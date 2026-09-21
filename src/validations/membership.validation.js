// src/validations/membership.validation.js
import { z } from 'zod';

// Mirrors membershipRoleEnum. A literal list rather than something derived
// from the Drizzle enum, for the same reason counterparty.validation.js keeps
// its own: the API contract and the column are allowed to diverge for a
// release, and silently following the column would hide that it happened.
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'staff', 'customer'];

export const grantMembershipSchema = z.object({
  // Better Auth ids are strings it generates, not uuids, so this validates
  // shape and length only. The foreign key is what rejects an id that names
  // nobody -- and it does so without this endpoint having to reveal whether a
  // given id exists.
  user_id: z.string().min(1).max(255),
  role: z.enum(MEMBERSHIP_ROLES),
});

export const listMembershipsQuerySchema = z.object({
  role: z.enum(MEMBERSHIP_ROLES).optional(),
  is_active: z
    .union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true')
    .optional(),
});

export const membershipIdSchema = z.object({
  id: z.string().uuid('Membership id must be a uuid'),
});
