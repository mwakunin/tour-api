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

import { and, desc, eq, inArray } from 'drizzle-orm';

import { withTenantDb, currentTenantId } from '#config/tenantContext.js';
import { db } from '#config/database.js';
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
  // ONE statement, not read-then-write. The old shape selected for an
  // existing row and inserted in a separate transaction, so two concurrent
  // grants of the same role could both observe "no row yet" and both insert;
  // the unique constraint then turned one valid grant into a 500. The
  // constraint is still there, but as the serialisation point rather than a
  // failure: whoever loses the race takes the conflict arm instead of
  // erroring.
  //
  // Re-granting a revoked role reactivates the original row rather than
  // inserting a second one -- reactivating keeps created_at as the date they
  // first held it. A re-grant of an already-active row is idempotent: same
  // is_active it already had, updated_at bumped, which is what the old
  // update arm did too.
  const [granted] = await withTenantDb((tx) =>
    tx
      .insert(memberships)
      .values({ tenant_id: currentTenantId(), user_id, role })
      .onConflictDoUpdate({
        target: [memberships.tenant_id, memberships.user_id, memberships.role],
        set: { is_active: true, updated_at: new Date() },
      })
      .returning()
  );

  // No granted-vs-reactivated split in the log any more: one statement
  // cannot report which arm fired, and an extra read just to label a log
  // line would reintroduce the read-then-act window this replaced. A
  // re-grant is a grant.
  logger.info('[membership] granted', {
    membershipId: granted.id,
    role,
    tenantId: currentTenantId(),
  });
  return granted;
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
  // ONE transaction, not three. The read, the admin-count and the update used
  // to be three separate withTenantDb calls, which means three separate round
  // trips with nothing holding the row still between them. Two concurrent
  // revocations of two DIFFERENT admins could each read "another admin is
  // still active" before either write lands, and both then deactivate --
  // leaving zero. The invariant this function exists to enforce cannot be
  // checked and then acted on in separate transactions; something has to
  // serialize the two requests, which is what the lock below does.
  const revoked = await withTenantDb(async (tx) => {
    const [target] = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        is_active: memberships.is_active,
      })
      .from(memberships)
      .where(eq(memberships.id, id))
      .limit(1);

    if (!target) throw new Error(NOT_FOUND);

    if (target.is_active && ADMIN_ROLES.includes(target.role)) {
      // Locks every currently-active admin row for this tenant. A second
      // transaction revoking a DIFFERENT admin concurrently tries to lock the
      // same rows here and blocks until this one commits or rolls back --
      // then re-reads and sees the count this transaction actually left
      // behind, not a stale one read before either write happened.
      //
      // Scoped to admin roles only, not every active membership: locking the
      // whole table would serialize an admin revocation against every
      // unrelated grant and revoke in the tenant for no reason.
      const activeAdmins = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.is_active, true),
            inArray(memberships.role, ADMIN_ROLES)
          )
        )
        .for('update');

      const otherAdmins = activeAdmins.filter((row) => row.id !== id);

      if (otherAdmins.length === 0) throw new Error(LAST_ADMIN);
    }

    const [row] = await tx
      .update(memberships)
      .set({ is_active: false, updated_at: new Date() })
      .where(eq(memberships.id, id))
      .returning();

    return row;
  });

  logger.info('[membership] revoked', {
    membershipId: revoked.id,
    role: revoked.role,
    tenantId: currentTenantId(),
  });
  return revoked;
};

// A short, bounded retry. The realistic failure here is a transient one -- a
// dropped connection, a pool briefly exhausted -- and that should not strand
// an account over a blip that would have cleared on its own.
const GRANT_RETRY_ATTEMPTS = 3;
const GRANT_RETRY_DELAY_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Grants the customer membership a fresh sign-up needs. Called from
 * utils/auth.js's databaseHooks, once per registration.
 *
 * WHY THIS CANNOT BE MADE ATOMIC WITH THE SIGN-UP ITSELF
 *
 * better-auth queues a `create.after` hook with queueAfterTransactionHook
 * (@better-auth/core context/transaction.mjs) and runs it once the user's OWN
 * transaction has already committed. By the time this function is called, the
 * user row is durably there whether or not this succeeds -- there is no
 * shared transaction left to roll back into. An earlier version of this hook
 * logged the failure and returned, which is honest about that constraint but
 * leaves exactly the account CodeRabbit's review flagged: committed, with no
 * membership, unable to reach any tenant-scoped route, and unable to sign up
 * again because the email is now taken.
 *
 * WHAT THIS DOES INSTEAD: RETRY, THEN UNDO
 *
 * If every retry fails, the failure is not transient, and a user this hook
 * cannot finish setting up is not a user this system can use. So it deletes
 * the row it cannot grant a membership to -- account and session cascade with
 * it, see user.model.js -- and rethrows. Compensating for a write that cannot
 * be rolled back, rather than a rollback itself.
 *
 * That is a real trade, not a free fix: a caller who wins the race against a
 * genuine outage sees their sign-up fail outright instead of silently
 * succeeding with no membership. Failing loudly and leaving the email free to
 * try again is judged the better failure of the two -- an account nobody can
 * use is not a saved account.
 *
 * If the compensating delete ALSO fails, that is the one case this cannot
 * resolve on its own, and it is logged as exactly that: two failures, needing
 * a human.
 */
export const grantSignupMembership = async (userId, tenantId) => {
  if (!tenantId) {
    // Not retryable -- there is no tenant to grant against, which means this
    // ran outside resolveTenant. That is a wiring bug, not a blip, so it goes
    // straight to the same compensating cleanup as an exhausted retry rather
    // than spending three attempts confirming what is already certain.
    await undoSignup(userId, null);
    throw new Error(
      '[membership] sign-up ran with no tenant context; the account could ' +
        'not be given a membership and was rolled back'
    );
  }

  let lastError;

  for (let attempt = 1; attempt <= GRANT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await db
        .insert(memberships)
        .values({ tenant_id: tenantId, user_id: userId, role: 'customer' })
        // Idempotent, because a retry here can meet the row its own earlier
        // attempt created: the insert commits the instant the statement
        // lands, and a connection lost AFTER that commit makes the caller
        // see a failure for work that is already done. Without this, the
        // unique violation counts as a failure, every retry burns, and
        // undoSignup deletes a user whose membership exists -- destroying a
        // finished sign-up over a blip that happened after the work. The
        // conflict is the memory of a success; treat it as one. Targeted at
        // the (tenant, user, role) key deliberately: any OTHER constraint
        // violating here is unanticipated and must stay loud.
        .onConflictDoNothing({
          target: [
            memberships.tenant_id,
            memberships.user_id,
            memberships.role,
          ],
        });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < GRANT_RETRY_ATTEMPTS) {
        await sleep(GRANT_RETRY_DELAY_MS * attempt);
      }
    }
  }

  await undoSignup(userId, tenantId, lastError);
  throw lastError;
};

const undoSignup = async (userId, tenantId, cause) => {
  logger.error(
    '[membership] sign-up could not be granted a membership after retries; ' +
      'undoing the account so the email is free to try again',
    { userId, tenantId, error: cause?.message }
  );

  try {
    await db.delete(user).where(eq(user.id, userId));
  } catch (cleanupError) {
    // The double failure this whole function exists to make rare. The
    // account is committed, has no membership, and could not be removed --
    // there is no automatic recovery left, and it needs a human with
    // DATABASE_URL.
    logger.error(
      '[membership] could not undo the account either -- this user is ' +
        'stuck with no membership and needs a human to fix it by hand',
      { userId, tenantId, error: cleanupError.message }
    );
  }
};
