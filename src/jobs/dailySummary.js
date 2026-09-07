// src/jobs/dailySummary.js
import { eq } from 'drizzle-orm';

import { emailService } from '../services/email.service.js';
import { db } from '../config/database.js';
import { runWithTenant } from '../config/tenantContext.js';
import { tenants } from '../models/tenant.model.js';
import logger from '../config/logger.js';

/**
 * Sends each active operator their own daily booking summary.
 *
 * This runs from a scheduler, not a request, so there is no middleware to
 * inherit a tenant from — it has to establish one per operator itself.
 *
 * Before tenancy this queried every booking in the database and emailed the
 * result to a single address. With one operator that was correct by accident;
 * with two it would send one operator a summary containing the other's
 * bookings and revenue. RLS cannot catch that, because a job with no tenant
 * set has nothing to scope to — hence the explicit loop.
 *
 * The operator list is read on the owner connection: enumerating tenants is by
 * definition a cross-tenant operation, and the runtime role can only ever see
 * its own row.
 */
export const sendDailySummary = async () => {
  const operators = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  logger.info(
    `Sending daily booking summary for ${operators.length} operator(s)`
  );

  for (const operator of operators) {
    // One operator failing must not stop the rest — a bad address or a Resend
    // outage for one is not a reason for the others to go dark.
    try {
      await runWithTenant(operator.id, () =>
        emailService.sendDailyBookingSummary()
      );
      logger.info(`Daily summary sent for ${operator.name}`);
    } catch (error) {
      logger.error(`Daily summary failed for ${operator.name}:`, error);
    }
  }
};

// Run every day at 8 PM
// You can use node-cron or run this via a scheduler
