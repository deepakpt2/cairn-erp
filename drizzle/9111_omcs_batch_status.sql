-- OMCS stores the client batch-status-management indicator. The stored
-- code is the SAP character from TCUCH-KZDZV: 1 active, blank not active.
-- It does not store a batch level, a plant selection, or an initial status.
-- It does not post movement 341 or 342. A closed period does not belong here.

CREATE TABLE batch_status_management (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  status_management char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client),
  CONSTRAINT batch_status_management_code_ck CHECK (status_management IN ('1', ' ')),
  CONSTRAINT batch_status_management_version_ck CHECK (version > 0)
);

ALTER TABLE batch_status_management ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_status_management FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_status_management
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_status_management FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_status_management TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHSTATUS.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Activate batch status management for the client. OMCS is a search alias only. The stored code is 1 or blank.'
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
  'CFG.INV.BATCHSTATUS.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Activate batch status management',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'Batch status for a later batch master',
  930,
  'STANDARD',
  '/config/batch-status',
  true,
  'MIGRATION_9111'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9111',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHSTATUS.DEFINE', 'NOT_STARTED', 'MIGRATION_9111'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHSTATUS.DEFINE', 'MIGRATION_9111'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.INV.MOVETYPE.CONFIG',
  'CFG.INV.VALCLASS.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHSTATUS.DEFINE',
  NULL,
  'Activate batch status management',
  'CONFIG_ACTIVITY',
  'INV',
  $omcs$Activate batch status management for the client. OMCS is a search alias only. The stored code is the character 1 when active, and blank when not active. It is not a batch level and not a plant list. The batch level is read from OMCE. At material or client level, an active indicator applies in every plant. At plant level it applies in a plant only after OMCU selects that plant; this screen does not select a plant. A batch that already stands blocks a change, because the conversion and movements 341 and 342 are not available. Setting the indicator does not create a batch, set an initial status, classify a batch, or make a movement require a batch. A closed posting period does not block this screen. A transport, an approval, and a company code are refused by name. The change document is the history. The lock is the configuration row.$omcs$,
  'TIER_2_CONFIGURED',
  '/config/batch-status',
  'B',
  'MIGRATION_9111'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9111',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCS', 'SEARCH_ONLY', 'MIGRATION_9111'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHSTATUS.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
