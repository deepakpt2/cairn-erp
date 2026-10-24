-- C223. Production version.
-- A version names one material BOM alternative and one standard routing.
-- It does not copy either master and does not rewrite a production order.
-- Engineering change management is not implemented. A change number is refused.
-- Repetitive manufacturing, rate routing, and product costing are not stored.
-- No usage, status, or version is seeded. Overlap is allowed until a tenant refuses it.

CREATE TABLE production_version_rule (
  client varchar(4) PRIMARY KEY REFERENCES client (client) ON DELETE CASCADE,
  refuse_overlap char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_version_rule_overlap_ck CHECK (refuse_overlap IN ('X', ' ')),
  CONSTRAINT production_version_rule_version_ck CHECK (version > 0)
);

CREATE TABLE production_version (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  production_version varchar(4) NOT NULL,
  description varchar(40),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  lot_from numeric(23, 3) NOT NULL,
  lot_to numeric(23, 3) NOT NULL,
  lot_unit varchar(6) NOT NULL REFERENCES unit_of_measure (code),
  bom_usage char(1) NOT NULL,
  bom_alternative varchar(2) NOT NULL,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  receiving_storage_location varchar(10),
  lock_indicator char(1) NOT NULL DEFAULT ' ',
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  check_status char(1) NOT NULL DEFAULT ' ',
  checked_at timestamptz,
  checked_by varchar(60),
  checked_bom_version integer,
  checked_routing_version integer,
  checked_plant_version integer,
  version integer NOT NULL DEFAULT 1,
  request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, material_number, plant, production_version),
  CONSTRAINT production_version_material_fk
    FOREIGN KEY (client, material_number, plant)
    REFERENCES material_plant (client, material_number, plant) ON DELETE RESTRICT,
  CONSTRAINT production_version_bom_fk
    FOREIGN KEY (client, material_number, plant, bom_usage, bom_alternative)
    REFERENCES material_bom (client, material_number, plant, usage, alternative) ON DELETE RESTRICT,
  CONSTRAINT production_version_routing_fk
    FOREIGN KEY (client, task_list_type, routing_group, group_counter)
    REFERENCES routing (client, task_list_type, routing_group, group_counter) ON DELETE RESTRICT,
  CONSTRAINT production_version_storage_fk
    FOREIGN KEY (client, plant, receiving_storage_location)
    REFERENCES storage_location (client, plant, storage_location) ON DELETE RESTRICT,
  CONSTRAINT production_version_key_ck CHECK (production_version ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT production_version_text_ck CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT production_version_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT production_version_lot_ck CHECK (lot_from >= 0 AND lot_to >= lot_from),
  CONSTRAINT production_version_lock_ck CHECK (lock_indicator IN (' ', '1')),
  CONSTRAINT production_version_deletion_ck CHECK (deletion_flag IN ('X', ' ')),
  CONSTRAINT production_version_check_ck CHECK (check_status IN (' ', '1', '2', '3')),
  CONSTRAINT production_version_version_ck CHECK (version > 0)
);

CREATE UNIQUE INDEX production_version_request_uq ON production_version (client, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX production_version_lookup_idx ON production_version (client, plant, material_number, valid_from, valid_to);

CREATE TABLE production_version_finding (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  production_version varchar(4) NOT NULL,
  code varchar(40) NOT NULL,
  severity char(1) NOT NULL,
  message varchar(200) NOT NULL,
  field_name varchar(40),
  referenced_object varchar(80),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, material_number, plant, production_version, code),
  CONSTRAINT production_version_finding_header_fk
    FOREIGN KEY (client, material_number, plant, production_version)
    REFERENCES production_version (client, material_number, plant, production_version) ON DELETE CASCADE,
  CONSTRAINT production_version_finding_severity_ck CHECK (severity IN ('E', 'W')),
  CONSTRAINT production_version_finding_message_ck CHECK (char_length(btrim(message)) BETWEEN 1 AND 200)
);

ALTER TABLE production_version_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_version_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_version_rule
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_version_rule FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_version_rule TO cairn_app;

ALTER TABLE production_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_version
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_version FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_version TO cairn_app;

ALTER TABLE production_version_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_version_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_version_finding
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_version_finding FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_version_finding TO cairn_app;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.PROD.VERSION.DEFINE',
  'PRODUCTION',
  NULL,
  'Define production version',
  'DEFINE',
  'CFG.PROD.ROUTING.DEFINE',
  'A production version a later planning or order step can select. This screen does not explode a BOM or rewrite an order.',
  969,
  'ONBOARDING',
  '/production/production-versions',
  true,
  'MIGRATION_9161'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9161',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.VERSION.DEFINE', 'NOT_STARTED', 'MIGRATION_9161'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  ('PROD.VERSION.CREATE', 'PROD', 'CREATE', false, 'Create a production version. C223 is a search alias. Saving does not explode a BOM, cost a product, or rewrite an order.'),
  ('PROD.VERSION.CHANGE', 'PROD', 'CHANGE', false, 'Change a production version. The material, plant, and version stay fixed. A saved order is not rewritten.'),
  ('PROD.VERSION.DISPLAY', 'PROD', 'DISPLAY', false, 'Display a production version. Display writes nothing and takes no change lock.'),
  ('PROD.VERSION.CHECK', 'PROD', 'CHECK', false, 'Run the production-version consistency check. The result is stored. It does not plan or post.'),
  ('PROD.VERSION.LOCK', 'PROD', 'LOCK', false, 'Lock or unlock a production version. A lock prevents selection. It does not delete the version.'),
  ('PROD.VERSION.DELETE', 'PROD', 'DELETE', false, 'Delete an unused production version, or mark a referenced one inactive. History is not erased.')
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES
  (
    gen_random_uuid()::text, 'PROD.VERSION.CREATE', 'production_version', 'Maintain production version',
    'TRANSACTION', 'PROD',
    'Maintain a production version. C223 is a search alias. The version names one BOM alternative and one standard routing. It does not copy them. A change number is refused. A formula is not calculated. A production order is not rewritten.',
    'TIER_1_BUILT', '/production/production-versions', 'B', 'MIGRATION_9161'
  ),
  (
    gen_random_uuid()::text, 'PROD.VERSION.CHANGE', null, 'Change production version',
    'TRANSACTION', 'PROD',
    'Change a production version. The material, plant, and version are fixed. A saved production order is not rewritten.',
    'TIER_1_BUILT', '/production/production-versions', 'B', 'MIGRATION_9161'
  ),
  (
    gen_random_uuid()::text, 'PROD.VERSION.DISPLAY', null, 'Display production version',
    'TRANSACTION', 'PROD',
    'Display a production version. Display writes nothing and takes no change lock.',
    'TIER_1_BUILT', '/production/production-version-display', 'B', 'MIGRATION_9161'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9161',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'C223', 'SEARCH_ONLY', 'MIGRATION_9161'
FROM term_registry t
WHERE t.our_code = 'PROD.VERSION.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;
