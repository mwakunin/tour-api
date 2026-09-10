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
// requireRole and isTenantAdmin both read req.membership, so what this
// function returns IS the access decision. A null return denies rather than
// falls back -- see requireRole, which distinguishes null (no tenant context,
// a wiring bug) from [] (asked and answered: they hold nothing here).

import { eq, and, ne } from 'drizzle-orm';

import { db } from '#config/database.js';
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
 * Whether `userId` is known to the ambient tenant at all.
 *
 * The `user` table is Better Auth's: no tenant_id, no RLS, one global pool. So
 * a handler that looks a user up by id reaches every operator's users, and an
 * admin acting on `/users/:id` would otherwise be able to modify or delete
 * someone who belongs entirely to a different operator. Membership is the only
 * thing that says whose user this is.
 *
 * Deliberately NOT filtered on is_active. The question here is "is this person
 * one of ours", and someone whose access was revoked still is -- filtering
 * them out would make deactivating a member the one thing that put them beyond
 * an administrator's reach, which is backwards. `is_active` governs what they
 * may do, not what may be done to them.
 *
 * Reads through withTenantDb, so the RLS policy scopes the rows to the current
 * tenant. There is no tenant_id in the WHERE clause because the policy is what
 * makes this correct, not a filter somebody has to remember to write.
 */
export const isTenantMember = async (userId) => {
  if (!currentTenantId() || !userId) return false;

  const rows = await withTenantDb((tx) =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.user_id, userId))
      .limit(1)
  );

  return rows.length > 0;
};

/**
 * Whether `userId` also belongs to some operator OTHER than the ambient one.
 *
 * `user` is one global row shared by every operator the person works for, so a
 * mutation of it is not confined to the tenant that performs it. Renaming or
 * re-emailing a shared account changes it everywhere, and DELETE is worse:
 * memberships.user_id is ON DELETE CASCADE, so removing the user row silently
 * removes that person from every other operator too. An administrator at one
 * operator has no authority to do either.
 *
 * THIS ONE USES THE OWNER CONNECTION, DELIBERATELY.
 *
 * It has to. The RLS policy on `memberships` restricts the runtime connection
 * to the current tenant's rows, so from inside tenant A the question "does this
 * person also belong to B?" is unanswerable by construction -- every such row
 * is invisible. It is the same shape of question as tenant resolution, which
 * bypasses RLS for the same reason (see tenant.middleware.js).
 *
 * It is safe because of what it returns, not where it sits: a boolean derived
 * from at most one row, selecting a single column, for a user id the caller has
 * already been shown belongs to their own tenant. It cannot enumerate operators
 * and it exposes no data about them.
 *
 * Fails CLOSED. With no tenant context there is no "other" to compare against,
 * so it reports true and the caller refuses -- an unanswerable safety question
 * is not a yes.
 */
export const belongsToOtherTenants = async (userId) => {
  const tenantId = currentTenantId();

  if (!tenantId || !userId) return true;

  const rows = await db
    .select({ tenant_id: memberships.tenant_id })
    .from(memberships)
    .where(
      and(eq(memberships.user_id, userId), ne(memberships.tenant_id, tenantId))
    )
    .limit(1);

  return rows.length > 0;
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
