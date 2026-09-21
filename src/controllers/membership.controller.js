// src/controllers/membership.controller.js

import {
  listMemberships,
  grantMembership,
  revokeMembership,
  NOT_FOUND,
  LAST_ADMIN,
} from '#services/membership.service.js';
import {
  grantMembershipSchema,
  listMembershipsQuerySchema,
  membershipIdSchema,
} from '#validations/membership.validation.js';
import logger from '#config/logger.js';

export const listMembershipsController = async (req, res) => {
  const parsed = listMembershipsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid query',
      details: parsed.error.issues,
    });
  }

  try {
    const data = await listMemberships(parsed.data);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[membership] list failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to list members' });
  }
};

export const grantMembershipController = async (req, res) => {
  const parsed = grantMembershipSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid membership',
      details: parsed.error.issues,
    });
  }

  try {
    const data = await grantMembership(parsed.data);
    res.status(201).json({ success: true, data });
  } catch (error) {
    // 23503: foreign_key_violation -- no user by that id. Answered as a plain
    // 400 rather than a 404 naming the user, because this endpoint is
    // admin-only but still must not become a way to test which account ids
    // exist across the whole deployment.
    if (error.cause?.code === '23503') {
      return res.status(400).json({
        success: false,
        error: 'Unknown user',
        message: 'No account with that id. They must sign up first.',
      });
    }

    logger.error('[membership] grant failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to grant access' });
  }
};

export const revokeMembershipController = async (req, res) => {
  const parsed = membershipIdSchema.safeParse(req.params);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid membership id',
    });
  }

  try {
    const data = await revokeMembership(parsed.data.id);
    res.json({ success: true, data });
  } catch (error) {
    if (error.message === NOT_FOUND) {
      return res
        .status(404)
        .json({ success: false, error: 'Membership not found' });
    }

    if (error.message === LAST_ADMIN) {
      // 409, not 403. The caller is permitted to do this -- the operator would
      // simply be left with nobody who could undo it, and recovering means a
      // hand-written INSERT against the database.
      return res.status(409).json({
        success: false,
        error: 'Last administrator',
        message:
          'This is the only active administrator. Grant someone else admin ' +
          'first, or nobody will be able to grant it afterwards.',
      });
    }

    logger.error('[membership] revoke failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to revoke access' });
  }
};
