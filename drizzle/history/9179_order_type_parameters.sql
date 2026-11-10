-- OPL8. Parameters dependent on production order type and plant.
-- The SAP key is client, plant, and order type. The plant key follows the
-- standing plant master. It is not shortened to four characters.
-- Order category 10 is copied from the production order type. It is not entered.
-- A task list type is optional and must already stand. Production version
-- selection is blank, 0, or 1. Naming either value does not select a master.
-- Costing, settlement, release, routing selection, a BOM application, a
-- selection ID, and checking control are not stored. Saving does not create
-- an order and does not change numbering.

CREATE TABLE production_order_type_parameter (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  order_type varchar(4) NOT NULL,
  order_category char(2) NOT NULL DEFAULT '10',
  task_list_type char(1),
  production_version_selection char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, plant, order_type),
  CONSTRAINT production_order_type_parameter_plant_fk
    FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT production_order_type_parameter_type_fk
    FOREIGN KEY (client, order_type) REFERENCES production_order_type (client, order_type) ON DELETE RESTRICT,
  CONSTRAINT production_order_type_parameter_task_list_fk
    FOREIGN KEY (client, task_list_type) REFERENCES routing_task_list_type (client, task_list_type) ON DELETE RESTRICT,
  CONSTRAINT production_order_type_parameter_type_ck CHECK (order_type ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_order_type_parameter_plant_ck CHECK (char_length(plant) BETWEEN 1 AND 10),
  CONSTRAINT production_order_type_parameter_category_ck CHECK (order_category = '10'),
  CONSTRAINT production_order_type_parameter_task_ck CHECK (task_list_type IS NULL OR task_list_type ~ '^[A-Z0-9]$'),
  CONSTRAINT production_order_type_parameter_version_sel_ck CHECK (production_version_selection IN (' ', '0', '1')),
  CONSTRAINT production_order_type_parameter_version_ck CHECK (version > 0)
);

ALTER TABLE production_order_type_parameter ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_type_parameter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_order_type_parameter
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_order_type_parameter FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_order_type_parameter TO cairn_app;

COMMENT ON TABLE production_order_type_parameter IS
  'OPL8 production order parameters. Key is plant and order type. Not an order and not checking control.';

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROD.ORDERPARAM.DEFINE',
  'PROD',
  'CONFIGURE',
  false,
  'Define parameters for a production order type in a plant. No order is created.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.PROD.ORDERPARAM.DEFINE',
  'PRODUCTION',
  NULL,
  'Define order type-dependent parameters',
  'DEFINE',
  'CFG.ORG.PLANT.DEFINE,CFG.PROD.ORDERTYPE.DEFINE',
  'A plant and production order type combination, without creating an order',
  969,
  'STANDARD',
  '/config/order-type-parameters',
  true,
  'MIGRATION_9179'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9179',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.ORDERPARAM.DEFINE', 'NOT_STARTED', 'MIGRATION_9179'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.PROD.ORDERPARAM.DEFINE', 'MIGRATION_9179'
FROM role_capability rc
WHERE rc.capability_code IN ('CFG.ORG.PLANT.DEFINE', 'CFG.PLT.CLIENT.ONBOARD')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROD.ORDERPARAM.DEFINE',
  NULL,
  'Order type-dependent parameters',
  'CONFIG_ACTIVITY',
  'PROD',
  $opl8$Order type-dependent parameters. OPL8 is a search alias. The key is a standing plant and a standing production order type. The category is the production-order category only. A task list type is optional and must already stand. Production version selection is blank, 0, or 1. Neither value selects a master. Costing, settlement, release, status profile, routing selection, a BOM application, a selection ID, scheduling, and checking control are not stored. Creating the record does not create an order and does not change numbering. CO01 and conversion do not read it.$opl8$,
  'TIER_2_CONFIGURED',
  '/config/order-type-parameters',
  'B',
  'MIGRATION_9179'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9179',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OPL8', 'SEARCH_ONLY', 'MIGRATION_9179'
FROM term_registry t
WHERE t.our_code = 'CFG.PROD.ORDERPARAM.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
