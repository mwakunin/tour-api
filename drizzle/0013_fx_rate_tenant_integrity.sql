-- A ledger entry may only reference its own tenant's FX rate, or a shared one.
--
-- This cannot be a composite foreign key. Shared rates carry tenant_id IS NULL,
-- and a FOREIGN KEY (tenant_id, fx_rate_id) REFERENCES fx_rates(tenant_id, id)
-- would never match them — every shared rate would be rejected. MATCH SIMPLE
-- does not help either: it only relaxes when the referencing columns are null,
-- and ledger_entries.tenant_id is NOT NULL.
--
-- So the rule is enforced by a trigger, which can express the disjunction the
-- constraint cannot: the referenced rate belongs to this tenant, or to nobody.

CREATE OR REPLACE FUNCTION public.ledger_entry_fx_rate_tenant_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rate_tenant uuid;
  rate_exists boolean;
BEGIN
  IF NEW.fx_rate_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id, true INTO rate_tenant, rate_exists
  FROM fx_rates WHERE id = NEW.fx_rate_id;

  IF NOT COALESCE(rate_exists, false) THEN
    RAISE EXCEPTION 'fx_rate % does not exist', NEW.fx_rate_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- NULL tenant is a shared reference rate every tenant may cite.
  IF rate_tenant IS NOT NULL AND rate_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'ledger entry for tenant % may not reference fx_rate % owned by tenant %',
      NEW.tenant_id, NEW.fx_rate_id, rate_tenant
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ledger_entries_fx_rate_tenant_check
  BEFORE INSERT OR UPDATE OF fx_rate_id, tenant_id ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public.ledger_entry_fx_rate_tenant_check();
