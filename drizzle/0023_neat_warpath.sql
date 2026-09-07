-- Attributing money to a booking, from both directions.
--
-- bookings.agent_id   the trade agent who brought it, whose commission is
--                     raised as a payable against the booking
-- supplier_invoices.booking_id
--                     which trip a supplier's cost belongs to, when it
--                     belongs to one
--
-- Together these are what make a per-booking P&L possible: revenue from the
-- receivable, cost of sales from attributed supplier invoices, commission from
-- the agent payable, and margin as what is left.

ALTER TABLE "bookings" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_booking_tenant_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoices_booking_idx" ON "supplier_invoices" USING btree ("tenant_id","booking_id");
--> statement-breakpoint

-- The agent foreign key is written here rather than declared on the model.
--
-- Drizzle would need booking.model.js to import counterparties from
-- money.model.js, and money.model.js imports payment.model.js, which imports
-- booking.model.js. That cycle is evaluated at module load and produces
-- "Cannot access X before initialization" -- the exact trap CLAUDE.md
-- documents. Postgres does not care where the constraint was written, so it
-- is written where it costs nothing.
--
-- Composite, like every other cross-table reference here: a single-column
-- reference would let one tenant's booking name another tenant's agent, and
-- Postgres would validate it internally without complaint.
--
-- RESTRICT rather than SET NULL: an agent with commission already raised
-- against a booking is not one to remove, and counterparties.deleteAgent
-- already degrades to deactivation for exactly this reason.

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_agent_tenant_fk"
  FOREIGN KEY ("tenant_id","agent_id")
  REFERENCES "public"."counterparties"("tenant_id","id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "bookings_agent_idx" ON "bookings" USING btree ("tenant_id","agent_id");
