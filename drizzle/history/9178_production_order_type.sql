-- OPJH. Production order type customizing only.
-- The SAP key is client and order type. It is not a plant key.
-- Order category 10 is the production-order category. Internal orders,
-- process orders, and networks are not this table.
-- Number range, settlement, status profile, release, and checking control
-- are not stored. Creating a type does not create an order and does not
-- change numbering.

CREATE TABLE production_order_type (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  order_type varchar(4) NOT NULL,
  description varchar(40) NOT NULL,
  order_category char(2) NOT NULL DEFAULT '10',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, order_type),
  CONSTRAINT production_order_type_key_ck CHECK (order_type ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_order_type_text_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT production_order_type_category_ck CHECK (order_category = '10'),
  CONSTRAINT production_order_type_version_ck CHECK (version > 0)
);

ALTER TABLE production_order_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_type FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_order_type
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_order_type FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_order_type TO cairn_app;

COMMENT ON TABLE production_order_type IS
  'OPJH production order type. Client key, category 10. Not a plant parameter and not an order.';

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROD.ORDERTYPE.DEFINE',
  'PROD',
  'CONFIGURE',
  false,
  'Define a production order type. The key is four characters and is not a plant. No order is created.'
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
  'CFG.PROD.ORDERTYPE.DEFINE',
  'PRODUCTION',
  NULL,
  'Define production order type',
  'DEFINE',
  'CFG.ORG.PLANT.DEFINE',
  'A production order type key, without creating an order or a checking control',
  968,
  'STANDARD',
  '/config/production-order-types',
  true,
  'MIGRATION_9178'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9178',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.ORDERTYPE.DEFINE', 'NOT_STARTED', 'MIGRATION_9178'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.PROD.ORDERTYPE.DEFINE', 'MIGRATION_9178'
FROM role_capability rc
WHERE rc.capability_code IN ('CFG.ORG.PLANT.DEFINE', 'CFG.PLT.CLIENT.ONBOARD')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROD.ORDERTYPE.DEFINE',
  NULL,
  'Production order type',
  'CONFIG_ACTIVITY',
  'PROD',
  $opjh$Production order type. OPJH is a search alias. The key is four characters and is not a plant. The category is the production-order category only. A description is required. Number range, settlement, status profile, release, scheduling, costing, and checking control are not stored. Creating a type does not create an order and does not change numbering. CO01 and conversion do not read it.$opjh$,
  'TIER_2_CONFIGURED',
  '/config/production-order-types',
  'B',
  'MIGRATION_9178'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9178',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OPJH', 'SEARCH_ONLY', 'MIGRATION_9178'
FROM term_registry t
WHERE t.our_code = 'CFG.PROD.ORDERTYPE.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
