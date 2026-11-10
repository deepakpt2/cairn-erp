-- COOIS. A read-only list. No production, confirmation, or stock row is changed.
-- A layout stores field ids for one user. It does not store report rows.

CREATE INDEX IF NOT EXISTS material_document_line_production_order_idx
  ON material_document_line (client, production_order_number)
  WHERE production_order_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS production_order_plant_idx
  ON production_order (client, plant, order_number);

CREATE TABLE IF NOT EXISTS report_layout (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  layout_id varchar(36) NOT NULL,
  owner varchar(60) NOT NULL,
  object_category varchar(20) NOT NULL,
  list_type varchar(32) NOT NULL,
  name varchar(40) NOT NULL,
  description varchar(80) NOT NULL DEFAULT '',
  field_ids varchar(400) NOT NULL,
  sort_field varchar(40) NOT NULL,
  sort_direction varchar(4) NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_layout_pk PRIMARY KEY (client, layout_id),
  CONSTRAINT report_layout_name_uq UNIQUE (client, owner, object_category, list_type, name),
  CONSTRAINT report_layout_object_ck CHECK (object_category IN ('PRODUCTION_ORDER', 'PLANNED_ORDER')),
  CONSTRAINT report_layout_direction_ck CHECK (sort_direction IN ('ASC', 'DESC')),
  CONSTRAINT report_layout_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 40)
);

CREATE UNIQUE INDEX IF NOT EXISTS report_layout_default_uq
  ON report_layout (client, owner, object_category, list_type)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS report_layout_owner_idx
  ON report_layout (client, owner, object_category, list_type);

ALTER TABLE report_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_layout FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON report_layout;
CREATE POLICY tenant_isolation ON report_layout
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON report_layout FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_layout TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.ORDER.INFO',
  'PROD',
  'DISPLAY',
  false,
  'List production orders and planned orders. COOIS is a search alias. The list does not create, change, confirm, or post. Cost is not shown.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT DISTINCT rc.client, rc.role_code, 'PROD.ORDER.INFO', 'MIGRATION_9171'
FROM role_capability rc
WHERE rc.capability_code = 'PROD.ORDER.DISPLAY'
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.ORDER.INFO',
  NULL,
  'Production order information',
  'TRANSACTION',
  'PROD',
  'List production orders and planned orders. COOIS is a search alias. Order headers, components, confirmations, documented goods movements, and planned orders are read from the records that stand. Operations, sequences, capacities, automatic goods movements, and purchase documents are not this list. A check writes nothing. Cost is not shown. CO03, CO02, CO11N, CO15, and MD13 are other screens.',
  'TIER_1_BUILT',
  '/production/order-information',
  'B',
  'MIGRATION_9171'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9171',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'COOIS', 'SEARCH_ONLY', 'MIGRATION_9171'
FROM term_registry t
WHERE t.our_code = 'PROD.ORDER.INFO'
ON CONFLICT (external_system, alias) DO NOTHING;
