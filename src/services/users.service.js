import logger from '#config/logger.js';
// Better Auth's `user` table is global -- no tenant_id, no policy, and a person
// may work for two operators.
//
// This note used to end "nothing to leak by operator". That was wrong, and the
// reads below were the proof: listing the table unscoped handed one operator
// every other operator's customers by name and email. What confines a read is
// the join to `memberships`, which IS policied -- so the listing goes through
// withTenantDb and lets the policy do the filtering.
import { appDb } from '#config/appDatabase.js';
import { withTenantDb } from '#config/tenantContext.js';
import { user } from '#models/user.model.js';
import { memberships } from '#models/membership.model.js';
import { ADMIN_ROLES } from '#middleware/auth.middleware.js';
import {
  and,
  eq,
  or,
  ilike,
  inArray,
  exists,
  notExists,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/**
 * The people who belong to THIS operator.
 *
 * The inner join is the boundary, not a convenience. `user` is global;
 * `memberships` is policied. Joining through withTenantDb means the policy
 * filters the membership rows before the join happens, so a person who works
 * only for another operator has no row to join to and cannot appear -- they
 * are not excluded by a WHERE clause somebody has to remember to write.
 *
 * selectDistinct because one person may hold several roles here, and they are
 * one entry in a list of users rather than three.
 */
export const getAllUsers = async (filters = {}) => {
  try {
    const { search, role, limit = 100, offset = 0 } = filters;

    const result = await withTenantDb((tx) => {
      // Revoked memberships used to join too, which put a former member back
      // in the operator's own user list -- somebody who left is still a row
      // in `memberships`, kept deliberately (loadMembership's own doc
      // comment: the record survives, is_active is what stops them acting).
      // That is right for authorization and wrong for a directory: this list
      // is who the operator can currently reach, not who once could.
      const conditions = [eq(memberships.is_active, true)];

      if (search && search.trim() !== '') {
        const searchTerm = `%${search.trim()}%`;
        conditions.push(
          or(ilike(user.name, searchTerm), ilike(user.email, searchTerm))
        );
      }

      // eq(user.role, role) used to be the filter. user.role is the global
      // Better Auth column, and nothing in the grant path
      // (membership.service.js) ever writes it -- so filtering on it answered
      // "whose LEGACY role string says admin", which stopped meaning anything
      // the moment authority moved to memberships. A filter for 'user' found
      // whoever this deployment happened to leave untouched; a filter for
      // 'admin' missed every admin promoted through /api/memberships and
      // could include an admin at a DIFFERENT operator who merely shares this
      // one.
      //
      // Bucketed the same way getUserStats buckets, rather than compared
      // directly to memberships.role: the query params are still the
      // legacy two values (admin/user) the client sends, and "admin" here
      // means "holds an admin-tier membership row here", nothing about a
      // string on the global user.
      // Built unconditionally: the same subquery both filters (below) and
      // projects (the role CASE), so the role column in the response and the
      // role query param answer the same question about the same rows.
      const roleCheck = alias(memberships, 'role_check');
      const holdsAdminHere = tx
        .select({ id: roleCheck.id })
        .from(roleCheck)
        .where(
          and(
            eq(roleCheck.user_id, user.id),
            eq(roleCheck.is_active, true),
            inArray(roleCheck.role, ADMIN_ROLES)
          )
        );

      if (role === 'admin' || role === 'user') {
        conditions.push(
          role === 'admin' ? exists(holdsAdminHere) : notExists(holdsAdminHere)
        );
      }

      return (
        tx
          .selectDistinct({
            id: user.id,
            email: user.email,
            name: user.name,
            // The response contract still says 'admin' or 'user' -- but the
            // value now answers it about THIS operator. user.role is the
            // global Better Auth column the grant path never writes, so
            // projecting it reported whatever legacy string the row carried:
            // a member promoted through /api/memberships still showed their
            // ancient global role, and nobody promoted ever showed 'admin'.
            // Bucketed exactly like the filter above and getUserStats:
            // 'admin' means an active admin-tier membership here; anything
            // else reads as 'user'. The exists is per-user, not
            // per-joined-row, so DISTINCT still collapses a person holding
            // several roles into one entry with one correct bucket.
            role: sql`CASE WHEN ${exists(holdsAdminHere)} THEN 'admin' ELSE 'user' END`.as(
              'role'
            ),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          })
          .from(user)
          .innerJoin(memberships, eq(memberships.user_id, user.id))
          .where(and(...conditions))
          // A page is only a page if the order behind it is fixed. DISTINCT
          // plus limit/offset with no ORDER BY lets Postgres hand back rows in
          // whatever order the chosen plan produces, so page 2 could repeat or
          // skip somebody page 1 already showed as the plan shifted underneath
          // it. Both keys are in the DISTINCT select list, as SELECT DISTINCT
          // requires of an ORDER BY; the id breaks ties because created_at is
          // only microsecond-precise and seed batches share one now().
          .orderBy(user.createdAt, user.id)
          .limit(limit)
          .offset(offset)
      );
    });

    // No `search` here: it is user-supplied and routinely an email address.
    logger.info(`Found ${result.length} users`, { role, limit, offset });

    return result;
  } catch (e) {
    logger.error('Error getting users', e);
    throw e;
  }
};

export const getUserById = async (id) => {
  try {
    const [foundUser] = await appDb
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      .from(user)
      .where(eq(user.id, id))
      .limit(1);

    if (!foundUser) {
      throw new Error('User not found');
    }

    return foundUser;
  } catch (e) {
    logger.error(`Error getting user by id ${id}:`, e);
    throw e;
  }
};

export const updateUser = async (id, updates) => {
  try {
    // First check if user exists
    const existingUser = await getUserById(id);

    // Check if email is being updated and if it already exists
    if (updates.email && updates.email !== existingUser.email) {
      const [emailExists] = await appDb
        .select()
        .from(user)
        .where(eq(user.email, updates.email))
        .limit(1);
      if (emailExists) {
        throw new Error('Email already exists');
      }
    }

    // Add updated_at timestamp
    const updateData = {
      ...updates,
      updatedAt: new Date(),
    };

    const [updatedUser] = await appDb
      .update(user)
      .set(updateData)
      .where(eq(user.id, id))
      .returning({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });

    logger.info('User updated successfully', { userId: updatedUser.id });
    return updatedUser;
  } catch (e) {
    logger.error(`Error updating user ${id}:`, e);
    throw e;
  }
};

export const deleteUser = async (id) => {
  try {
    // First check if user exists
    await getUserById(id);

    const [deletedUser] = await appDb
      .delete(user)
      .where(eq(user.id, id))
      .returning({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });

    logger.info('User deleted successfully', { userId: deletedUser.id });
    return deletedUser;
  } catch (e) {
    logger.error(`Error deleting user ${id}:`, e);
    throw e;
  }
};

// Add this function to the end of src/services/users.service.js

/**
 * Headcount for THIS operator, counted from memberships.
 *
 * It used to select the whole `user` table and tally `user.role`, which gave
 * every operator the same number: the size of the deployment. It also counted
 * a column that no longer decides anything -- authority moved to memberships,
 * so 'admins' meant "rows with a legacy string set" rather than "people who
 * can administer this operator".
 *
 * Distinct users, not membership rows: somebody who is both staff and a
 * customer here is one person, and would otherwise be counted twice in the
 * total and once in each bucket.
 */
export const getUserStats = async () => {
  try {
    const rows = await withTenantDb((tx) =>
      tx
        .select({
          user_id: memberships.user_id,
          role: memberships.role,
        })
        .from(memberships)
        .where(eq(memberships.is_active, true))
    );

    const everyone = new Set(rows.map((row) => row.user_id));
    const adminIds = new Set(
      rows
        .filter((row) => row.role === 'owner' || row.role === 'admin')
        .map((row) => row.user_id)
    );

    const total = everyone.size;
    const admins = adminIds.size;
    // Everyone who is not an administrator here. Named `regular` because the
    // response shape is part of the admin dashboard's contract.
    const regular = total - admins;

    logger.info(
      `User stats: Total=${total}, Admins=${admins}, Regular=${regular}`
    );

    return { total, admins, regular };
  } catch (error) {
    logger.error('Error getting user stats:', error);
    throw error;
  }
};
