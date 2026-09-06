-- Where an operator's notifications go.
--
-- The daily booking summary and the new-booking alert were both sent to a
-- deployment-wide ADMIN_EMAIL. The bookings they report are tenant scoped --
-- the job iterates operators inside runWithTenant -- but the recipient was
-- not, so every operator's totals and revenue arrived in whichever inbox the
-- deployment named. RLS cannot catch that: the query is correct, the address
-- is not.
--
-- Nullable rather than backfilled: callers fall back to the env var, so the
-- seeded tenant keeps working unchanged until an operator sets its own.

ALTER TABLE "tenants" ADD COLUMN "admin_email" text;
