-- Sequence privileges for tables added after 0009.
--
-- 0009 ran GRANT USAGE, SELECT ON ALL SEQUENCES, which reads as a standing
-- rule but is a one-time snapshot: it covers the sequences that existed the
-- moment it ran and nothing created afterwards.
--
-- Nothing needs one today -- every table on this branch keys on uuid, so there
-- is no sequence for the runtime role to use. That is exactly why this would
-- be missed: the first serial or identity column somebody adds later inherits
-- no privilege, and the failure surfaces at runtime as `permission denied for
-- sequence` on an INSERT rather than when the migration runs.
--
-- Default privileges are the standing rule. They apply to objects created from
-- here on by the role executing this statement, which is the role every
-- migration runs as.
--
-- Sequences only, deliberately. The same argument would extend to tables, but
-- a blanket default grant there would hand the runtime role every future table
-- without anyone deciding to -- and 0008 and 0009 grant table access one name
-- at a time precisely so that stays a decision. A sequence carries no data of
-- its own, so it has no such objection.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tourops_app;
