-- Extend row-level security to the tables that predate tenancy.
--
-- Every service and controller now reaches Postgres through the
-- RLS-constrained connection (see tenantContext.js), so the policies have
-- something to constrain. Landing them earlier would have made every handler
-- return zero rows.
--
-- Test fixtures are unaffected. They seed data on the owner connection as
-- `postgres`, and a SUPERUSER bypasses RLS entirely — FORCE only reaches a
-- non-superuser table owner. That is deliberate: fixtures should set up state
-- without fighting the policies, while the handlers under test go through
-- `tourops_app`, which cannot bypass anything.
--
-- Better Auth's user/session/account/verification stay uncovered: they are
-- global by design, carry no tenant_id, and a person may work for two
-- operators.
--
-- The tenant_id DEFAULT is NOT dropped here. Doing both at once would mix a
-- policy change with a NOT NULL change across 40 fixture inserts, and when
-- something failed there would be no telling which half caused it.

ALTER TABLE "tours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tours" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tours_tenant_isolation" ON "tours"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "destinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "destinations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "destinations_tenant_isolation" ON "destinations"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "tour_destinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tour_destinations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tour_destinations_tenant_isolation" ON "tour_destinations"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bookings_tenant_isolation" ON "bookings"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "payments_tenant_isolation" ON "payments"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "files_tenant_isolation" ON "files"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "blog_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blog_categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "blog_categories_tenant_isolation" ON "blog_categories"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint
ALTER TABLE "blog_posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blog_posts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "blog_posts_tenant_isolation" ON "blog_posts"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());
