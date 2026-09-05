import logger from '#config/logger.js';
// Better Auth's `user` table is global — no tenant_id, no policy, nothing to
// leak by operator, and a person may work for two of them. It still goes
// through the RLS-constrained connection: the policied tables stay policied
// here, so this is not a back door, just the right pool.
import { appDb } from '#config/appDatabase.js';
import { user } from '#models/user.model.js';
import { eq, or, ilike } from 'drizzle-orm';

export const getAllUsers = async (filters = {}) => {
  try {
    const { search, role, limit = 100, offset = 0 } = filters;

    // Start building the query
    let query = appDb
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      .from(user);

    // Apply search filter if provided (case-insensitive)
    if (search && search.trim() !== '') {
      const searchTerm = `%${search.trim()}%`;
      query = query.where(
        or(ilike(user.name, searchTerm), ilike(user.email, searchTerm))
      );
    }

    // Apply role filter if provided
    if (role && role !== 'all') {
      query = query.where(eq(user.role, role));
    }

    // Apply pagination
    query = query.limit(limit).offset(offset);

    const result = await query;

    logger.info(`Found ${result.length} users with filters:`, {
      search,
      role,
      limit,
      offset,
    });

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

    logger.info(`User ${updatedUser.email} updated successfully`);
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

    logger.info(`User ${deletedUser.email} deleted successfully`);
    return deletedUser;
  } catch (e) {
    logger.error(`Error deleting user ${id}:`, e);
    throw e;
  }
};

// Add this function to the end of src/services/users.service.js

export const getUserStats = async () => {
  try {
    logger.info('Getting user statistics...');

    const allUsers = await appDb.select().from(user);

    const total = allUsers.length;
    const admins = allUsers.filter((u) => u.role === 'admin').length;
    const regular = allUsers.filter((u) => u.role === 'user').length;

    logger.info(
      `User stats: Total=${total}, Admins=${admins}, Regular=${regular}`
    );

    return {
      total,
      admins,
      regular,
    };
  } catch (error) {
    logger.error('Error getting user stats:', error);
    throw error;
  }
};
