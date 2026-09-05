-- Row-level security for the money layer.
--
-- Isolation belongs in Postgres, not in application discipline. A scoped
-- client is a convention, and the failure mode of a convention is one
-- forgotten WHERE clause — silent, invisible in review, and indistinguishable
-- from correct code until one operator sees another operator's supplier
-- invoices.
--
-- SCOPE: the money-layer tables and `tenants` only. The legacy tables
-- (bookings, tours, payments, ...) are deliberately NOT covered yet. Nothing
-- queries the money layer today, so enabling policies here has a blast radius
-- of zero and lets the mechanism be proven against real tables. Those tables
-- join the policy set in the change that migrates their handlers onto the
-- tenant-scoped connection and drops the tenant_id DEFAULT.
--
-- WHY A SEPARATE ROLE: `FORCE ROW LEVEL SECURITY` still exempts the table
-- owner. An app that keeps connecting as the owner has decorative policies.
-- Migrations run as the owner; the runtime connects as `tourops_app`, which
-- owns nothing and cannot bypass RLS.
--
-- The role is created NOLOGIN here on purpose — a password does not belong in
-- a committed migration. Grant it login separately:
--     pnpm run db:app-role          (reads APP_DB_PASSWORD from the env)

-- ============ 1. the tenant setting ============
-- NULLIF guards the empty string: current_setting returns '' in some contexts
-- and ''::uuid raises, which would turn a missing tenant into a 500 rather
-- than into zero rows.
CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- ============ 2. the runtime role ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tourops_app') THEN
    CREATE ROLE tourops_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO tourops_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "counterparties","obligations","settlements","allocations","fx_rates","ledger_entries"
  TO tourops_app;--> statement-breakpoint
-- Tenants is read-only to the runtime: creating and suspending operators is
-- an owner-plane operation, not something a request handler may do.
GRANT SELECT ON "tenants" TO tourops_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO tourops_app;--> statement-breakpoint

-- ============ 3. policies ============
-- USING governs what is visible; WITH CHECK governs what may be written. Both
-- are required — without WITH CHECK a handler could insert a row attributed to
-- another tenant and simply not be able to read it back.
--
-- With no tenant set, current_tenant_id() is NULL, every comparison is NULL,
-- and each table returns zero rows. Never everything.

ALTER TABLE "counterparties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "counterparties" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "counterparties_tenant_isolation" ON "counterparties"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

ALTER TABLE "obligations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "obligations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "obligations_tenant_isolation" ON "obligations"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

ALTER TABLE "settlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settlements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "settlements_tenant_isolation" ON "settlements"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

ALTER TABLE "allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "allocations_tenant_isolation" ON "allocations"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ledger_entries_tenant_isolation" ON "ledger_entries"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

-- fx_rates is the one asymmetric table: a NULL tenant_id is a shared reference
-- rate every tenant may read, but a tenant may only ever WRITE its own.
ALTER TABLE "fx_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fx_rates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fx_rates_tenant_isolation" ON "fx_rates"
  USING ("tenant_id" IS NULL OR "tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

-- A tenant may see only its own row, and never write one.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenants_self_only" ON "tenants" FOR SELECT
  USING ("id" = public.current_tenant_id());
