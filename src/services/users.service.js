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
import { and, eq, or, ilike } from 'drizzle-orm';

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

    // Collected and applied once: a second .where() REPLACES the first in
    // Drizzle rather than adding to it, so searching and filtering by role
    // together silently dropped the search.
    const conditions = [];

    if (search && search.trim() !== '') {
      const searchTerm = `%${search.trim()}%`;
      conditions.push(
        or(ilike(user.name, searchTerm), ilike(user.email, searchTerm))
      );
    }

    if (role && role !== 'all') {
      conditions.push(eq(user.role, role));
    }

    const result = await withTenantDb((tx) => {
      const query = tx
        .selectDistinct({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        })
        .from(user)
        .innerJoin(memberships, eq(memberships.user_id, user.id));

      return conditions.length > 0
        ? query
            .where(and(...conditions))
            .limit(limit)
            .offset(offset)
        : query.limit(limit).offset(offset);
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
