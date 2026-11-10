-- OMCU selects the plants in which batch status management applies when
-- the batch level is plant. The stored code is T001W-CHAZV, domain XFELD:
-- X selected, blank not selected. Absence of a row is not selected.
-- Opening this screen does not select a plant. It does not post movement
-- 341 or 342, and it does not rewrite stock.

CREATE TABLE batch_status_plant (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  status_active char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, plant),
  CONSTRAINT batch_status_plant_plant_fk FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE CASCADE,
  CONSTRAINT batch_status_plant_code_ck CHECK (status_active IN ('X', ' ')),
  CONSTRAINT batch_status_plant_version_ck CHECK (version > 0)
);

CREATE TABLE batch_status_plant_conversion (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  conversion_run_id varchar(36) NOT NULL,
  plant varchar(10) NOT NULL,
  prior_active char(1) NOT NULL,
  requested_active char(1) NOT NULL,
  status varchar(24) NOT NULL,
  batch_count integer NOT NULL,
  stock_batch_count integer NOT NULL,
  document_batch_count integer NOT NULL,
  error_summary text NOT NULL,
  reason varchar(500) NOT NULL,
  started_by varchar(60) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, conversion_run_id),
  CONSTRAINT batch_status_plant_conversion_plant_fk FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE CASCADE,
  CONSTRAINT batch_status_plant_conversion_status_ck CHECK (status = 'BLOCKED'),
  CONSTRAINT batch_status_plant_conversion_code_ck CHECK (prior_active IN ('X', ' ') AND requested_active IN ('X', ' '))
);

ALTER TABLE batch_status_plant ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_status_plant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_status_plant
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_status_plant FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_status_plant TO cairn_app;

ALTER TABLE batch_status_plant_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_status_plant_conversion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_status_plant_conversion
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_status_plant_conversion FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_status_plant_conversion TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHSTATUSPLANT.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Select plants for batch status management. OMCU is a search alias only. The stored code is X or blank. It does not post movement 341 or 342.'
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
  'CFG.INV.BATCHSTATUSPLANT.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Batch status management in plant',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'Plant selection for batch status when the level is plant',
  955,
  'STANDARD',
  '/config/batch-status-plants',
  true,
  'MIGRATION_9126'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9126',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHSTATUSPLANT.DEFINE', 'NOT_STARTED', 'MIGRATION_9126'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHSTATUSPLANT.DEFINE', 'MIGRATION_9126'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHSTATUS.DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.INV.BATCHRANGE.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHSTATUSPLANT.DEFINE',
  NULL,
  'Batch status management in plant',
  'CONFIG_ACTIVITY',
  'INV',
  $omcu$Batch status management in plant. OMCU is a search alias only. The stored code is T001W-CHAZV, character X when selected and blank when not selected. It is not the OMCS character 1 and not a boolean. The plant name is read from the plant master and is not stored here. The selection applies only when the batch level is plant. At material or client level it is refused, and OMCS is not changed. Opening this screen does not select a plant. A change is refused when a batch, batched stock, or a material document already stands in the plant, because movements 341 and 342 are not available. Stock is not rewritten. Restricted use is not blocked stock and not inspection stock. A closed posting period does not block this screen. A transport, a company code, an initial status, and a plant name are refused by name.$omcu$,
  'TIER_2_CONFIGURED',
  '/config/batch-status-plants',
  'B',
  'MIGRATION_9126'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9126',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCU', 'SEARCH_ONLY', 'MIGRATION_9126'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHSTATUSPLANT.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
