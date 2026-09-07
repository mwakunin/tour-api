-- One settlement per payment, enforced by the database.
--
-- recordBookingSettlement checked for an existing settlement and then
-- inserted, which is the same read-then-write shape as the completion races:
-- two retried callbacks both find nothing and both insert, and the ledger
-- records the money twice.
--
-- Partial, because outbound settlements — supplier payouts, agent commissions
-- — have no payment_id, and a plain unique index would collapse all of them
-- into one row per tenant.

CREATE UNIQUE INDEX "settlements_tenant_payment_unique"
  ON "settlements" ("tenant_id", "payment_id")
  WHERE "payment_id" IS NOT NULL;
