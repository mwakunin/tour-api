-- Scope the supplier-invoice booking SET NULL to the column it means.
--
-- 0023 wrote the constraint as a plain ON DELETE SET NULL over the composite
-- (tenant_id, booking_id). Postgres accepts that at definition time and then
-- nulls EVERY column in the key when a parent row is deleted:
--
--   UPDATE ONLY supplier_invoices SET tenant_id = NULL, booking_id = NULL ...
--
-- tenant_id is NOT NULL, so the delete fails instead of clearing the
-- attribution. Deleting any booking that had a supplier invoice attributed to
-- it would have failed, and only ever in production, on real data, long after
-- this was written.
--
-- This is the same trap CLAUDE.md already documents for
-- blog_posts_category_tenant_fk in 0007, in the same words, about the same
-- Postgres behaviour. It was written down and walked into anyway.
--
-- The column-scoped form says what was meant: clear the attribution, leave the
-- tenant alone. Postgres 15+, which 0007 already requires.
--
-- Drizzle cannot express the column list, so its snapshot still records a
-- plain `set null` and src/models/supplierInvoice.model.js still declares
-- .onDelete('set null'). That divergence is deliberate and must stay --
-- regenerating this statement reintroduces the bug.

ALTER TABLE "supplier_invoices"
  DROP CONSTRAINT "supplier_invoices_booking_tenant_fk";--> statement-breakpoint

ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT "supplier_invoices_booking_tenant_fk"
  FOREIGN KEY ("tenant_id","booking_id")
  REFERENCES "public"."bookings"("tenant_id","id")
  ON DELETE SET NULL ("booking_id") ON UPDATE no action;
