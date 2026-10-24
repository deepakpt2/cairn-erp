-- CO11N. A time ticket is a confirmation of one routing operation.
-- The production order does not gain an operation, a sequence, or a status.
-- Created and released remain the only order statuses.
-- No goods movement and no journal are posted by this table.

CREATE TABLE IF NOT EXISTS production_confirmation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  confirmation_number varchar(12) NOT NULL,
  order_number varchar(12) NOT NULL,
  operation_number varchar(4) NOT NULL,
  sequence char(6) NOT NULL DEFAULT '000000',
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  production_version varchar(4) NOT NULL,
  work_center varchar(8),
  work_center_plant varchar(10) NOT NULL,
  control_key varchar(4) NOT NULL,
  short_text varchar(40),
  confirmation_type varchar(8) NOT NULL,
  yield_quantity numeric(23, 3) NOT NULL,
  scrap_quantity numeric(23, 3) NOT NULL,
  rework_quantity numeric(23, 3) NOT NULL,
  unit varchar(10) NOT NULL,
  posting_date date NOT NULL,
  execution_start timestamp,
  execution_finish timestamp,
  note varchar(200),
  request_key varchar(64) NOT NULL,
  order_version integer NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_confirmation_pk PRIMARY KEY (client, confirmation_number),
  CONSTRAINT production_confirmation_order_fk FOREIGN KEY (client, order_number)
    REFERENCES production_order (client, order_number) ON DELETE RESTRICT,
  CONSTRAINT production_confirmation_type_ck CHECK (confirmation_type IN ('PARTIAL', 'FINAL')),
  CONSTRAINT production_confirmation_sequence_ck CHECK (sequence = '000000'),
  CONSTRAINT production_confirmation_operation_ck CHECK (operation_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_confirmation_quantity_ck CHECK (
    yield_quantity >= 0 AND scrap_quantity >= 0 AND rework_quantity >= 0
  ),
  CONSTRAINT production_confirmation_times_ck CHECK (
    execution_start IS NULL OR execution_finish IS NULL OR execution_finish >= execution_start
  ),
  CONSTRAINT production_confirmation_version_ck CHECK (order_version > 0),
  CONSTRAINT production_confirmation_note_ck CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS production_confirmation_request_uq
  ON production_confirmation (client, request_key);

CREATE UNIQUE INDEX IF NOT EXISTS production_confirmation_final_uq
  ON production_confirmation (client, order_number, operation_number)
  WHERE confirmation_type = 'FINAL';

CREATE INDEX IF NOT EXISTS production_confirmation_order_idx
  ON production_confirmation (client, order_number, operation_number);

CREATE TABLE IF NOT EXISTS production_confirmation_activity (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  confirmation_number varchar(12) NOT NULL,
  parameter varchar(6) NOT NULL,
  quantity numeric(23, 3) NOT NULL,
  unit varchar(6) NOT NULL,
  suggested_quantity numeric(23, 3),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_confirmation_activity_pk PRIMARY KEY (client, confirmation_number, parameter),
  CONSTRAINT production_confirmation_activity_fk FOREIGN KEY (client, confirmation_number)
    REFERENCES production_confirmation (client, confirmation_number) ON DELETE CASCADE,
  CONSTRAINT production_confirmation_activity_qty_ck CHECK (quantity >= 0),
  CONSTRAINT production_confirmation_activity_suggested_ck CHECK (suggested_quantity IS NULL OR suggested_quantity >= 0)
);

ALTER TABLE production_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_confirmation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_confirmation;
CREATE POLICY tenant_isolation ON production_confirmation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_confirmation FROM PUBLIC;
GRANT SELECT, INSERT ON production_confirmation TO cairn_app;

ALTER TABLE production_confirmation_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_confirmation_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_confirmation_activity;
CREATE POLICY tenant_isolation ON production_confirmation_activity
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_confirmation_activity FROM PUBLIC;
GRANT SELECT, INSERT ON production_confirmation_activity TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.CONFIRM.ENTER',
  'PROD',
  'CREATE',
  false,
  'Enter a time ticket for one operation of a released production order. CO11N is a search alias. A posted confirmation is not edited here. The order status stays created or released. No goods movement and no journal are posted.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT DISTINCT rc.client, rc.role_code, 'PROD.CONFIRM.ENTER', 'MIGRATION_9169'
FROM role_capability rc
WHERE rc.capability_code IN ('PROD.ORDER.RELEASE', 'PROD.ORDER.GI')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.CONFIRM.ENTER',
  NULL,
  'Enter time ticket',
  'TRANSACTION',
  'PROD',
  'Enter a time ticket for one operation of a released production order. CO11N is a search alias. The operation is read from the production version. It is not stored on the order. Partial leaves the operation open. Final blocks another confirmation of that operation and does not change the order status. A check writes nothing. A repeated request returns the same confirmation. Backflush, automatic goods receipt, a confirmation profile, personnel, and cancellation are not this screen. CO13 and CO14 are not implemented. The confirmation posts no goods movement and no journal.',
  'TIER_1_BUILT',
  '/production/time-ticket',
  'B',
  'MIGRATION_9169'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9169',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'CO11N', 'SEARCH_ONLY', 'MIGRATION_9169'
FROM term_registry t
WHERE t.our_code = 'PROD.CONFIRM.ENTER'
ON CONFLICT (external_system, alias) DO NOTHING;
