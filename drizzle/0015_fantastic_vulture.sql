-- Idempotent restatement of migration 0014.
--
-- 0014 was written by hand and applied before the Drizzle model caught up, so
-- drizzle-kit generated this as a fresh change. Both are kept: this one is a
-- no-op wherever 0014 already ran, and correct on a database built from
-- scratch, which keeps the snapshot consistent with the model.
--
-- Postgres has no CREATE TYPE IF NOT EXISTS, hence the DO block.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mpesa_shortcode_type') THEN
    CREATE TYPE "public"."mpesa_shortcode_type" AS ENUM('paybill', 'till');
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "mpesa_shortcode_type"
  "mpesa_shortcode_type" DEFAULT 'paybill' NOT NULL;
