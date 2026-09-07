-- Shared FX rates: readable by every tenant, writable by none.
--
-- 0008 expressed the rule as a single policy covering every command:
--
--   USING      (tenant_id IS NULL OR tenant_id = current_tenant_id())
--   WITH CHECK (tenant_id = current_tenant_id())
--
-- with the comment "a tenant may only ever WRITE its own". The policy did not
-- actually say that. USING decides which existing rows a command may touch, so
-- it admitted shared rows to UPDATE and DELETE exactly as it did to SELECT.
-- WITH CHECK only constrains the row a write leaves behind, and it does not
-- apply to DELETE at all. Two consequences, both reachable by any tenant
-- through the runtime role:
--
--   DELETE  a tenant could delete a shared reference rate outright, removing
--           it from every other tenant.
--
--   UPDATE  a tenant could take ownership of a shared rate by setting
--           tenant_id to its own. WITH CHECK is satisfied, because the row
--           left behind belongs to the writer. Ledger entries in other tenants
--           already citing that rate would then point at a rate they can no
--           longer read, and 0013's trigger cannot catch it: that trigger
--           fires on ledger_entries, not on fx_rates.
--
-- Splitting per command says what was meant. No trigger is needed for the
-- ownership transfer either: once UPDATE's USING excludes shared rows, there is
-- no way to reach one, and WITH CHECK stops a tenant handing its own rate to
-- somebody else or back to the shared pool -- `NULL = current_tenant_id()` is
-- NULL, not true, so both directions fail.

DROP POLICY "fx_rates_tenant_isolation" ON "fx_rates";--> statement-breakpoint

CREATE POLICY "fx_rates_read" ON "fx_rates" FOR SELECT
  USING ("tenant_id" IS NULL OR "tenant_id" = public.current_tenant_id());--> statement-breakpoint

CREATE POLICY "fx_rates_insert" ON "fx_rates" FOR INSERT
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

CREATE POLICY "fx_rates_update" ON "fx_rates" FOR UPDATE
  USING ("tenant_id" = public.current_tenant_id())
  WITH CHECK ("tenant_id" = public.current_tenant_id());--> statement-breakpoint

CREATE POLICY "fx_rates_delete" ON "fx_rates" FOR DELETE
  USING ("tenant_id" = public.current_tenant_id());
