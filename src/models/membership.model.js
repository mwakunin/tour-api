// src/models/membership.model.js
//
// Which people may act at which operator, and as what.
//
// WHY THIS TABLE HAS TO EXIST
//
// `user`, `session` and `account` are Better Auth's. They carry no tenant_id
// and are not under RLS, so user accounts are a single global pool shared by
// every operator. Nothing in the schema could answer "does this user belong to
// this tenant?" -- and without an answer, the session and the hostname are two
// independent claims that nothing reconciles.
//
// That matters because the session cookie is set on the registrable domain
// (see crossSubDomainCookies in utils/auth.js), so the browser sends it to
// EVERY subdomain. A user signed in at one operator's hostname who points a
// request at another operator's hostname arrives holding a valid session. The
// hostname says one tenant, the cookie says a user, and before this table
// there was nothing that could object.
//
// HOW THE LOOKUP DEFENDS ITSELF
//
// This table is tenant-scoped and under RLS like every other, which is what
// makes the check structural rather than a comparison somebody has to remember
// to write. `loadMembership` queries it through `withTenantDb`, so the rows are
// already filtered to the resolved tenant: a membership at some OTHER operator
// is not rejected, it is invisible. A stray cookie finds zero rows and gets a
// 403 for the ordinary reason -- no membership here -- rather than because a
// hand-written guard caught it.
//
// This is the same shape school-saas arrived at (see its memberships table and
// withMembership middleware); tourops is the one that was missing it.
//
// ROLE LIVES HERE, NOT ON `user`
//
// `user.role` is one string for the whole system, so 'admin' currently means
// admin of every operator. Role belongs on the membership because the same
// login has to be able to hold different standing at different operators --
// staff at one, customer at another -- and because an operator must not be
// able to grant authority outside itself.
//
// requireRole reads this. `req.user.role` is no longer consulted for any
// access decision -- it survives only as a column the users admin screen
// filters and reports on.

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

import { tenants } from './tenant.model.js';
import { user } from './user.model.js';
import { membershipRoleEnum } from './enums.model.js';

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'restrict' })
      .notNull(),

    // text, not uuid: Better Auth generates its own string ids.
    //
    // CASCADE rather than RESTRICT, unlike the money layer. A membership is a
    // statement about a user that is meaningless once the user is gone, and it
    // records no money -- so deleting the user should take it, where deleting
    // a counterparty that an obligation references must be refused.
    user_id: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' })
      .notNull(),

    role: membershipRoleEnum('role').notNull(),

    // Revoking access without deleting the row, so an audit trail survives
    // someone leaving. Every lookup filters on it.
    is_active: boolean('is_active').default(true).notNull(),

    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // One row per role, so a person can be both staff and customer at the same
    // operator without either row having to encode the other. Authorization
    // asks whether the set intersects what a route allows.
    uniquePerRole: unique('memberships_tenant_user_role_key').on(
      table.tenant_id,
      table.user_id,
      table.role
    ),

    // The lookup every authenticated request makes: this user, this tenant.
    tenantUserIdx: index('memberships_tenant_user_idx').on(
      table.tenant_id,
      table.user_id
    ),

    // "Which operators does this person belong to?" -- needed to resolve the
    // tenant from a session when the hostname cannot name one, which is the
    // case for a single shared API host.
    userIdx: index('memberships_user_idx').on(table.user_id),

    tenantIdIdx: index('memberships_tenant_id_idx').on(table.tenant_id),

    // Target for composite foreign keys, matching the convention in
    // money.model.js: a child row references (tenant_id, id) so Postgres
    // refuses a pointer that crosses tenants.
    tenantScopedId: unique('memberships_tenant_id_id_key').on(
      table.tenant_id,
      table.id
    ),
  })
);

export const membershipsRelations = relations(memberships, ({ one }) => ({
  tenant: one(tenants, {
    fields: [memberships.tenant_id],
    references: [tenants.id],
  }),
  user: one(user, {
    fields: [memberships.user_id],
    references: [user.id],
  }),
}));
