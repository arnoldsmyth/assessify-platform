-- Custom migration: append-only enforcement (docs/spec/04-data-model.md, Invariants #1).
--
-- Ledger tables (entitlement_ledger, royalty_ledger, audit_log) are append-only:
-- no UPDATE or DELETE, ever. webhook_deliveries rows may have their delivery
-- status updated, but the event/payload of a delivery is immutable and rows are
-- never deleted.
--
-- Two layers of defence:
--   1. Triggers that reject the operation regardless of role (works everywhere,
--      including for table owners running ad-hoc SQL).
--   2. REVOKE UPDATE, DELETE from the application role, applied only if the
--      role exists (role name `assessify_app` is provisioned per environment).

CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;--> statement-breakpoint

CREATE TRIGGER entitlement_ledger_append_only
  BEFORE UPDATE OR DELETE ON entitlement_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();--> statement-breakpoint

CREATE TRIGGER royalty_ledger_append_only
  BEFORE UPDATE OR DELETE ON royalty_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();--> statement-breakpoint

-- webhook_deliveries: delivery bookkeeping (status, attempts, http_status,
-- next_retry_at, delivered_at) may change; the recorded event/payload may not,
-- and rows are never deleted.
CREATE OR REPLACE FUNCTION webhook_deliveries_immutable_payload() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on webhook_deliveries is not allowed: table is append-only'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.event IS DISTINCT FROM OLD.event
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook_deliveries event/payload are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER webhook_deliveries_append_only
  BEFORE UPDATE OR DELETE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_immutable_payload();--> statement-breakpoint

-- Belt-and-braces grants for the app role, when it exists in this environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessify_app') THEN
    REVOKE UPDATE, DELETE ON entitlement_ledger, royalty_ledger, audit_log FROM assessify_app;
    REVOKE DELETE ON webhook_deliveries FROM assessify_app;
  END IF;
END;
$$;
