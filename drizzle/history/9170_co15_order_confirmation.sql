-- CO15. A header confirmation is not a time ticket.
-- Existing rows are operation confirmations. The order still has no operation
-- table and no new status. No goods movement is posted.

ALTER TABLE production_confirmation
  ADD COLUMN IF NOT EXISTS confirmation_level varchar(12) NOT NULL DEFAULT 'OPERATION';

ALTER TABLE production_confirmation DROP CONSTRAINT IF EXISTS production_confirmation_level_ck;
ALTER TABLE production_confirmation
  ADD CONSTRAINT production_confirmation_level_ck
  CHECK (confirmation_level IN ('OPERATION', 'HEADER'));

ALTER TABLE production_confirmation ALTER COLUMN operation_number DROP NOT NULL;
ALTER TABLE production_confirmation ALTER COLUMN control_key DROP NOT NULL;
ALTER TABLE production_confirmation ALTER COLUMN work_center_plant DROP NOT NULL;

ALTER TABLE production_confirmation DROP CONSTRAINT IF EXISTS production_confirmation_level_shape_ck;
ALTER TABLE production_confirmation
  ADD CONSTRAINT production_confirmation_level_shape_ck
  CHECK (
    (confirmation_level = 'OPERATION' AND operation_number IS NOT NULL AND control_key IS NOT NULL AND work_center_plant IS NOT NULL)
    OR
    (confirmation_level = 'HEADER' AND operation_number IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS production_confirmation_header_final_uq
  ON production_confirmation (client, order_number)
  WHERE confirmation_level = 'HEADER' AND confirmation_type = 'FINAL';

CREATE TABLE IF NOT EXISTS production_confirmation_operation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  confirmation_number varchar(12) NOT NULL,
  order_number varchar(12) NOT NULL,
  operation_number varchar(4) NOT NULL,
  confirmation_type varchar(8) NOT NULL,
  yield_quantity numeric(23, 3) NOT NULL,
  scrap_quantity numeric(23, 3) NOT NULL,
  rework_quantity numeric(23, 3) NOT NULL,
  unit varchar(10) NOT NULL,
  work_center varchar(8),
  control_key varchar(4) NOT NULL,
  short_text varchar(40),
  quantity_basis varchar(24) NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_confirmation_operation_pk PRIMARY KEY (client, confirmation_number, operation_number),
  CONSTRAINT production_confirmation_operation_fk FOREIGN KEY (client, confirmation_number)
    REFERENCES production_confirmation (client, confirmation_number) ON DELETE CASCADE,
  CONSTRAINT production_confirmation_operation_order_fk FOREIGN KEY (client, order_number)
    REFERENCES production_order (client, order_number) ON DELETE RESTRICT,
  CONSTRAINT production_confirmation_operation_type_ck CHECK (confirmation_type IN ('PARTIAL', 'FINAL')),
  CONSTRAINT production_confirmation_operation_number_ck CHECK (operation_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_confirmation_operation_qty_ck CHECK (
    yield_quantity >= 0 AND scrap_quantity >= 0 AND rework_quantity >= 0
  ),
  CONSTRAINT production_confirmation_operation_basis_ck CHECK (quantity_basis IN ('ORDER_QUANTITY', 'OPERATION_QUANTITY'))
);

CREATE UNIQUE INDEX IF NOT EXISTS production_confirmation_operation_final_uq
  ON production_confirmation_operation (client, order_number, operation_number)
  WHERE confirmation_type = 'FINAL';

CREATE INDEX IF NOT EXISTS production_confirmation_operation_order_idx
  ON production_confirmation_operation (client, order_number, operation_number);

ALTER TABLE production_confirmation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_confirmation_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_confirmation_operation;
CREATE POLICY tenant_isolation ON production_confirmation_operation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_confirmation_operation FROM PUBLIC;
GRANT SELECT, INSERT ON production_confirmation_operation TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.CONFIRM.ORDER',
  'PROD',
  'CREATE',
  false,
  'Confirm a released production order at header level. CO15 is a search alias. Eligible operations receive an effect. A time ticket is not created for each operation. The order status is not changed. No goods movement and no journal are posted.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT DISTINCT rc.client, rc.role_code, 'PROD.CONFIRM.ORDER', 'MIGRATION_9170'
FROM role_capability rc
WHERE rc.capability_code IN ('PROD.CONFIRM.ENTER', 'PROD.ORDER.RELEASE')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.CONFIRM.ORDER',
  NULL,
  'Enter order confirmation',
  'TRANSACTION',
  'PROD',
  'Confirm a released production order at header level. CO15 is a search alias. One confirmation number is drawn. Each operation whose control key allows confirmation, and which is not already finally confirmed, receives that quantity as an effect. A separate time-ticket number is not created. An operation that requires an activity is not given a standard value. Automatic final confirmation is refused because no confirmation profile is stored. A check writes nothing. The order status stays created or released. Backflush and automatic goods receipt are not configured. CO11N, CO13, and CO14 are not this screen.',
  'TIER_1_BUILT',
  '/production/order-confirmation',
  'B',
  'MIGRATION_9170'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9170',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'CO15', 'SEARCH_ONLY', 'MIGRATION_9170'
FROM term_registry t
WHERE t.our_code = 'PROD.CONFIRM.ORDER'
ON CONFLICT (external_system, alias) DO NOTHING;
