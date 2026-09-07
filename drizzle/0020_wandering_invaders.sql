-- One FX rate per currency pair per day.
--
-- findRate orders by as_of DESC, then tenant_id DESC NULLS LAST, and takes the
-- first row. Two rows sharing a tenant and a date leave that ordering with no
-- tiebreaker, so which rate a conversion used came down to physical row order
-- -- and a correction loaded alongside the original could be ignored
-- indefinitely, silently, with the ledger entries already written against
-- whichever one won.
--
-- Nothing could load a second rate until now: fx_rates had no writer outside
-- tests. The endpoint added alongside this migration is exactly what makes the
-- collision reachable, which is why the constraint comes with it.
--
-- NULLS NOT DISTINCT because tenant_id is NULL on the shared reference rates.
-- Under Postgres's default every NULL is distinct from every other, so a plain
-- UNIQUE would constrain tenant-owned rates and leave the shared ones
-- unprotected -- the half that every tenant reads. Requires Postgres 15, which
-- 0007 already does.

ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_tenant_pair_date_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","base_currency","quote_currency","as_of");
