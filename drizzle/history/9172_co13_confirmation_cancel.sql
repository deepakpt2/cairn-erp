-- CO13. Cancel one posted confirmation.
-- The original confirmation and its activities are not updated.
-- A cancellation is a separate record. It is not a negative confirmation
-- and it does not reverse a material document.
-- A partial unique index cannot see this table, so active-final uniqueness
-- is a trigger. Cancelled originals are not active finals.

CREATE TABLE IF NOT EXISTS production_confirmation_cancellation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  cancellation_number varchar(12) NOT NULL,
  confirmation_number varchar(12) NOT NULL,
  order_number varchar(12) NOT NULL,
  reason varchar(200),
  request_key varchar(64) NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_confirmation_cancellation_pk PRIMARY KEY (client, cancellation_number),
  CONSTRAINT production_confirmation_cancellation_original_uq UNIQUE (client, confirmation_number),
  CONSTRAINT production_confirmation_cancellation_request_uq UNIQUE (client, request_key),
  CONSTRAINT production_confirmation_cancellation_fk FOREIGN KEY (client, confirmation_number)
    REFERENCES production_confirmation (client, confirmation_number) ON DELETE RESTRICT,
  CONSTRAINT production_confirmation_cancellation_order_fk FOREIGN KEY (client, order_number)
    REFERENCES production_order (client, order_number) ON DELETE RESTRICT,
  CONSTRAINT production_confirmation_cancellation_reason_ck CHECK (
    reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 200
  )
);

CREATE INDEX IF NOT EXISTS production_confirmation_cancellation_order_idx
  ON production_confirmation_cancellation (client, order_number);

ALTER TABLE production_confirmation_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_confirmation_cancellation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_confirmation_cancellation;
CREATE POLICY tenant_isolation ON production_confirmation_cancellation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_confirmation_cancellation FROM PUBLIC;
GRANT SELECT, INSERT ON production_confirmation_cancellation TO cairn_app;

-- The original confirmation stays insert-only for the application role.
REVOKE UPDATE, DELETE ON production_confirmation FROM cairn_app;
REVOKE UPDATE, DELETE ON production_confirmation_activity FROM cairn_app;
REVOKE UPDATE, DELETE ON production_confirmation_operation FROM cairn_app;

DROP INDEX IF EXISTS production_confirmation_final_uq;
DROP INDEX IF EXISTS production_confirmation_header_final_uq;
DROP INDEX IF EXISTS production_confirmation_operation_final_uq;

CREATE OR REPLACE FUNCTION production_confirmation_reject_second_active_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.confirmation_type IS DISTINCT FROM 'FINAL' THEN
    RETURN NEW;
  END IF;

  -- Same transaction may insert a header and then its effects. The lock is re-entrant.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.client || '|CO13-FINAL|' || NEW.order_number, 0));

  IF TG_TABLE_NAME = 'production_confirmation' AND NEW.confirmation_level = 'HEADER' THEN
    IF EXISTS (
      SELECT 1
        FROM production_confirmation c
       WHERE c.client = NEW.client
         AND c.order_number = NEW.order_number
         AND c.confirmation_level = 'HEADER'
         AND c.confirmation_type = 'FINAL'
         AND c.confirmation_number <> NEW.confirmation_number
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = c.client AND x.confirmation_number = c.confirmation_number
         )
    ) THEN
      RAISE EXCEPTION 'active final confirmation already stands'
        USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'production_confirmation' AND NEW.confirmation_level = 'OPERATION' THEN
    IF EXISTS (
      SELECT 1
        FROM production_confirmation c
       WHERE c.client = NEW.client
         AND c.order_number = NEW.order_number
         AND c.confirmation_level = 'OPERATION'
         AND c.operation_number = NEW.operation_number
         AND c.confirmation_type = 'FINAL'
         AND c.confirmation_number <> NEW.confirmation_number
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = c.client AND x.confirmation_number = c.confirmation_number
         )
    ) OR EXISTS (
      SELECT 1
        FROM production_confirmation_operation e
       WHERE e.client = NEW.client
         AND e.order_number = NEW.order_number
         AND e.operation_number = NEW.operation_number
         AND e.confirmation_type = 'FINAL'
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = e.client AND x.confirmation_number = e.confirmation_number
         )
    ) THEN
      RAISE EXCEPTION 'active final confirmation already stands'
        USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'production_confirmation_operation' THEN
    IF EXISTS (
      SELECT 1
        FROM production_confirmation_operation e
       WHERE e.client = NEW.client
         AND e.order_number = NEW.order_number
         AND e.operation_number = NEW.operation_number
         AND e.confirmation_type = 'FINAL'
         AND e.confirmation_number <> NEW.confirmation_number
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = e.client AND x.confirmation_number = e.confirmation_number
         )
    ) OR EXISTS (
      SELECT 1
        FROM production_confirmation c
       WHERE c.client = NEW.client
         AND c.order_number = NEW.order_number
         AND c.confirmation_level = 'OPERATION'
         AND c.operation_number = NEW.operation_number
         AND c.confirmation_type = 'FINAL'
         AND NOT EXISTS (
           SELECT 1 FROM production_confirmation_cancellation x
            WHERE x.client = c.client AND x.confirmation_number = c.confirmation_number
         )
    ) THEN
      RAISE EXCEPTION 'active final confirmation already stands'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION production_confirmation_reject_second_active_final() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION production_confirmation_reject_second_active_final() TO cairn_app;

DROP TRIGGER IF EXISTS production_confirmation_active_final_trg ON production_confirmation;
CREATE TRIGGER production_confirmation_active_final_trg
  BEFORE INSERT ON production_confirmation
  FOR EACH ROW
  EXECUTE FUNCTION production_confirmation_reject_second_active_final();

DROP TRIGGER IF EXISTS production_confirmation_operation_active_final_trg ON production_confirmation_operation;
CREATE TRIGGER production_confirmation_operation_active_final_trg
  BEFORE INSERT ON production_confirmation_operation
  FOR EACH ROW
  EXECUTE FUNCTION production_confirmation_reject_second_active_final();

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.CONFIRM.CANCEL',
  'PROD',
  'REVERSE',
  false,
  'Cancel one posted production-order confirmation. CO13 is a search alias. The original confirmation is not edited. No goods movement, journal, reservation, or order status is changed.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT DISTINCT rc.client, rc.role_code, 'PROD.CONFIRM.CANCEL', 'MIGRATION_9172'
FROM role_capability rc
WHERE rc.capability_code IN ('PROD.CONFIRM.ENTER', 'PROD.CONFIRM.ORDER')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.CONFIRM.CANCEL',
  NULL,
  'Cancel production order confirmation',
  'TRANSACTION',
  'PROD',
  'Cancel one posted confirmation. CO13 is a search alias. Operation and header confirmations are both in scope. The original confirmation and its activities stay as posted. A cancellation record is linked to that confirmation and can be written once. A cancelled final no longer blocks a new confirmation. A repeated request returns the same cancellation. No goods movement, journal, reservation, or order status is changed. A material document posted separately is not reversed here. CO14 is not this screen.',
  'TIER_1_BUILT',
  '/production/confirmation-cancel',
  'B',
  'MIGRATION_9172'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9172',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'CO13', 'SEARCH_ONLY', 'MIGRATION_9172'
FROM term_registry t
WHERE t.our_code = 'PROD.CONFIRM.CANCEL'
ON CONFLICT (external_system, alias) DO NOTHING;

UPDATE term_registry
   SET description = replace(description, 'CO13 and CO14 are not implemented.', 'Cancellation is CO13. CO14 is not implemented.'),
       changed_by = 'MIGRATION_9172',
       changed_at = now()
 WHERE our_code = 'PROD.CONFIRM.ENTER'
   AND description LIKE '%CO13 and CO14 are not implemented.%';
