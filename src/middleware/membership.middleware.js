// src/middleware/membership.middleware.js
//
// Loads the signed-in user's standing AT the resolved tenant.
//
// WHY THE QUERY IS THE CHECK
//
// This reads through `withTenantDb`, so it runs inside a transaction with
// `app.tenant_id` set and the RLS policy on `memberships` already applied. A
// membership at another operator is therefore not rejected -- it is invisible.
// That matters because the alternative is a comparison somebody has to
// remember to write, and the failure mode of a convention is one forgotten
// line.
//
// The case it defends: the session cookie is set on the registrable domain
// (crossSubDomainCookies in utils/auth.js), so the browser sends it to every
// subdomain. A user signed in at one operator who aims a request at another
// arrives holding a valid session. The session says who; the tenant says
// where; this is what reconciles them.
//
// LOADS, DOES NOT REFUSE
//
// Populating req.membership is separate from requiring a role, deliberately.
// Folding the two together makes every route that only needs a session
// unreachable to a user who has no membership yet -- which is exactly the
// situation a self-signup or an invitation-accept route exists to resolve.
// Refusal belongs in the guard, not in the load.
//
// NOTHING READS THIS FOR AUTHORIZATION YET. requireRole still consults
// req.user.role, so this file changes no access decision. Moving the call
// sites over is a separate change.

import { eq, and } from 'drizzle-orm';

import { memberships } from '#models/schema.js';
import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import logger from '#config/logger.js';

/**
 * The roles a user holds at the ambient tenant.
 *
 * Returns null when there is no tenant context to ask within — which is the
 * case for routes mounted before `resolveTenant`, such as the auth handlers
 * themselves. Not an empty membership: "nobody asked" and "asked, holds
 * nothing" are different answers, and a guard reading the second must not be
 * handed the first.
 */
export const loadMembership = async (userId) => {
  const tenantId = currentTenantId();

  if (!tenantId || !userId) return null;

  const rows = await withTenantDb((tx) =>
    tx
      .select({ id: memberships.id, role: memberships.role })
      .from(memberships)
      .where(
        and(eq(memberships.user_id, userId), eq(memberships.is_active, true))
      )
  );

  // tenant_id is not in the WHERE clause on purpose: the policy already
  // restricts the rows to the current tenant, and repeating it here would
  // suggest the filter is what makes this safe. It is not — remove the policy
  // and a duplicated WHERE would still be one edit away from being wrong.
  return {
    tenantId,
    roles: rows.map((row) => row.role),
  };
};

/**
 * Attaches `req.membership`, or leaves it null.
 *
 * Never fails the request. A membership lookup that throws is a database
 * problem, not an authentication one, and turning it into a 401 would tell the
 * user to sign in again for a fault that signing in cannot fix. The guards that
 * will read this treat null as "holds nothing", which is the safe direction.
 */
export const attachMembership = async (req) => {
  if (!req.user?.id) return;

  try {
    req.membership = await loadMembership(req.user.id);
  } catch (error) {
    req.membership = null;
    logger.error('[membership] lookup failed', {
      userId: req.user.id,
      tenantId: currentTenantId(),
      error: error.message,
    });
  }
};

/** Express form, for routes that want it explicitly in the chain. */
export const withMembership = async (req, _res, next) => {
  await attachMembership(req);
  next();
};
