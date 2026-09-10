import logger from '#config/logger.js';
import {
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  getUserStats,
} from '#services/users.service.js';
import {
  userIdSchema,
  updateUserSchema,
} from '#validations/users.validation.js';
import { formatValidationError } from '#utils/format.js';
import { isTenantAdmin } from '#middleware/auth.middleware.js';
import {
  isTenantMember,
  belongsToOtherTenants,
} from '#middleware/membership.middleware.js';

// Log lines are newline-delimited, so an id carrying CR/LF can forge extra
// entries. These are logged before validation runs, so they are sanitised here.
const safeForLog = (value) => String(value).replace(/[^\w-]/g, '');

export const fetchAllUsers = async (req, res, next) => {
  try {
    logger.info('Getting users...');

    // Extract filters from query parameters
    const filters = {
      search: req.query.search,
      role: req.query.role,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : undefined,
    };

    // Pass filters to the service
    const allUsers = await getAllUsers(filters);

    res.json({
      message: 'Successfully retrieved users',
      users: allUsers,
      count: allUsers.length,
      filters: {
        search: filters.search || null,
        role: filters.role || 'all',
        limit: filters.limit || 100,
        offset: filters.offset || 0,
      },
    });
  } catch (e) {
    logger.error(e);
    next(e);
  }
};

export const fetchUserById = async (req, res, next) => {
  try {
    logger.info(`Getting user by id: ${safeForLog(req.params.id)}`);

    // Validate the user ID parameter
    const validationResult = userIdSchema.safeParse({ id: req.params.id });

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: formatValidationError(validationResult.error),
      });
    }

    const { id } = validationResult.data;

    // Any signed-in caller could read any profile in the deployment, email and
    // role included. That was a deliberate single-tenant decision -- the route
    // comment says so -- and it stops being defensible the moment there is a
    // second operator, because "any signed-in caller" then includes their
    // competitors' staff.
    //
    // Self is always allowed: a person may read their own profile whether or
    // not they hold a membership anywhere.
    if (req.user?.id !== id && !(await isTenantMember(id))) {
      // The same body this handler returns for an id that exists nowhere, so a
      // caller cannot tell "not here" from "nowhere" -- see the matching
      // reasoning on the update and delete paths.
      return res.status(404).json({ error: 'User not found' });
    }

    const user = await getUserById(id);

    logger.info(`User ${user.id} retrieved successfully`);
    res.json({
      message: 'User retrieved successfully',
      user,
    });
  } catch (e) {
    logger.error(`Error fetching user by id: ${e.message}`);

    if (e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }

    next(e);
  }
};

export const updateUserById = async (req, res, next) => {
  try {
    logger.info(`Updating user: ${safeForLog(req.params.id)}`);

    // Validate the user ID parameter
    const idValidationResult = userIdSchema.safeParse({ id: req.params.id });

    if (!idValidationResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: formatValidationError(idValidationResult.error),
      });
    }

    // Validate the update data
    const updateValidationResult = updateUserSchema.safeParse(req.body);

    if (!updateValidationResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: formatValidationError(updateValidationResult.error),
      });
    }

    const { id } = idValidationResult.data;
    const updates = updateValidationResult.data;

    // Authorization checks
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'You must be logged in to update user information',
      });
    }

    // isTenantAdmin, not req.user.role: the Better Auth row's role is one
    // global string, so 'admin' there meant admin at every operator.
    if (!isTenantAdmin(req) && req.user.id !== id) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only update your own information',
      });
    }

    // Only admin users can change roles
    if (updates.role && !isTenantAdmin(req)) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Only administrators can change user roles',
      });
    }

    // Remove role from updates if non-admin user is trying to update their own profile
    if (!isTenantAdmin(req)) {
      delete updates.role;
    }

    // The actor is authorized; the TARGET still has to be this operator's to
    // touch. `user` is Better Auth's table -- global, no tenant_id, no RLS --
    // so updateUser(id) reaches every operator's users, and an admin here
    // could otherwise edit someone who belongs entirely to another operator.
    //
    // Only when acting on somebody else: a person updating their own profile
    // is always entitled to, and a fresh sign-up holds no membership yet, so
    // requiring one here would lock new users out of their own account.
    if (req.user.id !== id && !(await isTenantMember(id))) {
      // 404, not 403, and byte-for-byte the same body this handler already
      // returns for an id that exists nowhere. A 403 -- or a differently
      // worded 404 -- would confirm the id names a real account, which is
      // exactly what an administrator at another operator must not be able to
      // probe for. Indistinguishable is the point.
      return res.status(404).json({ error: 'User not found' });
    }

    // Membership here is necessary but not sufficient. `user` is one global
    // row shared by every operator the person works for, so editing it edits
    // it everywhere -- and this administrator's authority stops at their own
    // operator.
    if (req.user.id !== id && (await belongsToOtherTenants(id))) {
      return res.status(409).json({
        error: 'Shared account',
        message:
          'This person also works for another operator, so their account ' +
          'is not yours alone to change. Revoke their membership instead.',
      });
    }

    const updatedUser = await updateUser(id, updates);

    logger.info(`User ${updatedUser.id} updated successfully`);
    res.json({
      message: 'User updated successfully',
      user: updatedUser,
    });
  } catch (e) {
    logger.error(`Error updating user: ${e.message}`);

    if (e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }

    if (e.message === 'Email already exists') {
      return res.status(409).json({ error: 'Email already exists' });
    }

    next(e);
  }
};

export const deleteUserById = async (req, res, next) => {
  try {
    logger.info(`Deleting user: ${safeForLog(req.params.id)}`);

    // Validate the user ID parameter
    const validationResult = userIdSchema.safeParse({ id: req.params.id });
    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: formatValidationError(validationResult.error),
      });
    }

    const { id } = validationResult.data;

    // Authentication check
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'You must be logged in to delete users',
      });
    }

    // Authorization: Allow if user is deleting their own account OR if user is admin
    const isOwnAccount = req.user.id === id;
    const isAdmin = isTenantAdmin(req);

    //Optional: Prevent admin from deleting themselves (uncomment if needed)
    if (isAdmin && isOwnAccount) {
      return res.status(403).json({
        error: 'Operation denied',
        message:
          'Administrators cannot delete their own account. Please contact another admin.',
      });
    }

    if (!isOwnAccount && !isAdmin) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You can only delete your own account',
      });
    }

    // Same boundary as the update path, and it matters more here: deleteUser
    // removes the global Better Auth row, so an unscoped delete would destroy
    // an account belonging to another operator entirely.
    if (!isOwnAccount && !(await isTenantMember(id))) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Sharper here than on the update path. memberships.user_id is ON DELETE
    // CASCADE, so removing this row does not just delete an account -- it
    // silently strips the person from every other operator they work for. One
    // administrator must not be able to do that to another's staff.
    if (!isOwnAccount && (await belongsToOtherTenants(id))) {
      return res.status(409).json({
        error: 'Shared account',
        message:
          'This person also works for another operator, so deleting their ' +
          'account would remove them there too. Revoke their membership ' +
          'instead.',
      });
    }

    const deletedUser = await deleteUser(id);

    logger.info(
      `User ${deletedUser.id} deleted successfully by ${req.user.id}`
    );

    res.json({
      message: 'User deleted successfully',
      user: deletedUser,
    });
  } catch (e) {
    logger.error(`Error deleting user: ${e.message}`);
    if (e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    next(e);
  }
};

export const fetchUserStats = async (req, res, next) => {
  try {
    logger.info('Getting user statistics...');

    const stats = await getUserStats();

    res.json({
      success: true,
      message: 'User statistics retrieved successfully',
      data: stats,
    });
  } catch (error) {
    logger.error(`Error fetching user stats: ${error.message}`);
    next(error);
  }
};
