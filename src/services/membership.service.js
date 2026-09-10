// src/services/membership.service.js
//
// Who may act at this operator, and as what.
//
// This exists because the /users/:id paths refuse to delete an account shared
// with another operator and tell the administrator to revoke the membership
// instead -- advice with no endpoint behind it until now. Revoking is also the
// correct operation in the ordinary case: an operator wants somebody out of
// THEIR system, not erased from a system they may also work in.
//
// Every read and write goes through withTenantDb, so the RLS policy on
// `memberships` scopes it. A membership at another operator is not filtered
// out here -- it is invisible from here, which is why none of these queries
// carries a tenant_id in its WHERE clause.

import { and, desc, eq } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { memberships } from '#models/membership.model.js';
import { user } from '#models/user.model.js';
import { ADMIN_ROLES } from '#middleware/auth.middleware.js';
import logger from '#config/logger.js';

const NOT_FOUND = 'Membership not found';
const LAST_ADMIN = 'LAST_ADMIN';

export { NOT_FOUND, LAST_ADMIN };

/** Everyone who holds a role at this operator, with the person's name. */
export const listMemberships = (filters = {}) => {
  const { role, is_active } = filters;

  const conditions = [];
  if (role) conditions.push(eq(memberships.role, role));
  if (is_active !== undefined) {
    conditions.push(eq(memberships.is_active, is_active));
  }

  return withTenantDb((tx) =>
    tx
      .select({
        id: memberships.id,
        user_id: memberships.user_id,
        role: memberships.role,
        is_active: memberships.is_active,
        created_at: memberships.created_at,
        name: user.name,
        email: user.email,
      })
      .from(memberships)
      // Inner join, so a membership whose user row has gone takes itself out
      // of the list rather than appearing as a nameless row. The FK cascades,
      // so that should be impossible -- "should be" is why it is an inner join.
      .innerJoin(user, eq(memberships.user_id, user.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(memberships.created_at))
  );
};

/**
 * Grants a role at this operator to a user who already has an account.
 *
 * Deliberately not a sign-up. Creating the person and granting them authority
 * are separate acts, and conflating them would make "invite a colleague" a
 * path that mints accounts -- with an email nobody has verified.
 */
export const grantMembership = async ({ user_id, role }) => {
  const [existing] = await withTenantDb((tx) =>
    tx
      .select({ id: memberships.id, is_active: memberships.is_active })
      .from(memberships)
      .where(and(eq(memberships.user_id, user_id), eq(memberships.role, role)))
      .limit(1)
  );

  // Re-granting a revoked role reactivates the original row rather than
  // inserting a second one -- the unique constraint on (tenant, user, role)
  // would refuse the insert anyway, and reactivating keeps created_at as the
  // date they first held it.
  if (existing) {
    const [reactivated] = await withTenantDb((tx) =>
      tx
        .update(memberships)
        .set({ is_active: true, updated_at: new Date() })
        .where(eq(memberships.id, existing.id))
        .returning()
    );

    logger.info('[membership] reactivated', {
      membershipId: reactivated.id,
      role,
      tenantId: currentTenantId(),
    });
    return reactivated;
  }

  const [created] = await withTenantDb((tx) =>
    tx
      .insert(memberships)
      .values({ tenant_id: currentTenantId(), user_id, role })
      .returning()
  );

  logger.info('[membership] granted', {
    membershipId: created.id,
    role,
    tenantId: currentTenantId(),
  });
  return created;
};

/**
 * Revokes a membership: deactivates rather than deletes.
 *
 * The row is the record that this person once had this authority here, which
 * is exactly what an audit needs after they leave. is_active is what stops
 * them acting -- loadMembership filters on it -- so deleting buys nothing and
 * loses the history.
 *
 * Refuses to remove the last active administrator. An operator with nobody who
 * can grant a membership cannot recover without a hand-written INSERT, and the
 * mistake is one click.
 */
export const revokeMembership = async (id) => {
  const [target] = await withTenantDb((tx) =>
    tx
      .select({
        id: memberships.id,
        role: memberships.role,
        is_active: memberships.is_active,
      })
      .from(memberships)
      .where(eq(memberships.id, id))
      .limit(1)
  );

  if (!target) throw new Error(NOT_FOUND);

  if (target.is_active && ADMIN_ROLES.includes(target.role)) {
    const remaining = await withTenantDb((tx) =>
      tx
        .select({ id: memberships.id, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.is_active, true))
    );

    const otherAdmins = remaining.filter(
      (row) => row.id !== id && ADMIN_ROLES.includes(row.role)
    );

    if (otherAdmins.length === 0) throw new Error(LAST_ADMIN);
  }

  const [revoked] = await withTenantDb((tx) =>
    tx
      .update(memberships)
      .set({ is_active: false, updated_at: new Date() })
      .where(eq(memberships.id, id))
      .returning()
  );

  logger.info('[membership] revoked', {
    membershipId: revoked.id,
    role: revoked.role,
    tenantId: currentTenantId(),
  });
  return revoked;
};
