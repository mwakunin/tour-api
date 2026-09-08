-- Supplier invoices: the document a payable is raised from.
--
-- Deliberately does not carry the amount, the currency, the due date or a
-- status. Those live on the obligation raised alongside it, reachable through
-- (source_type, source_id) -- storing them here too would create two records
-- of the same number with nothing keeping them equal, and the one the ledger
-- uses would not be the one anybody reads. Outstanding stays derived from
-- allocations, so it cannot disagree with the money that actually moved.

CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"issued_on" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoices_number_per_supplier" UNIQUE("tenant_id","counterparty_id","invoice_number")
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_counterparty_tenant_fk" FOREIGN KEY ("tenant_id","counterparty_id") REFERENCES "public"."counterparties"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoices_tenant_id_idx" ON "supplier_invoices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_counterparty_idx" ON "supplier_invoices" USING btree ("tenant_id","counterparty_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_issued_on_idx" ON "supplier_invoices" USING btree ("tenant_id","issued_on");
--> statement-breakpoint

-- ============ tenancy ============
--
-- Both halves are required and neither is optional. Without the GRANT the
-- runtime role cannot touch the table at all; without the policies it could
-- read and write every tenant's invoices, because a table with RLS disabled
-- has no policy to fail. A new tenant-scoped table that gets one and not the
-- other is the failure this whole layer exists to prevent.
--
-- FORCE, because the owner is exempt from its own policies otherwise, and the
-- migration connection is the owner.

GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_invoices" TO tourops_app;--> statement-breakpoint

ALTER TABLE "supplier_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- USING governs what is visible, WITH CHECK what may be written. Both, so a
-- handler cannot insert a row attributed to another tenant and merely be
-- unable to read it back -- that is corruption rather than protection.
CREATE POLICY "supplier_invoices_tenant_isolation" ON "supplier_invoices"
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());
