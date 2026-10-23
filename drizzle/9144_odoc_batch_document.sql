-- ODOC stores the client indicator for batch document management.
-- The SAP field is TCUCD-KZDCD. X is active. Blank is not active.
-- Deactivation hides the batch-master tab. It does not delete a batch,
-- a document, or a link. No document info record is created here.

CREATE TABLE IF NOT EXISTS batch_document_management (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  document_management char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client),
  CONSTRAINT batch_document_management_code_ck CHECK (document_management in ('X', ' ')),
  CONSTRAINT batch_document_management_version_ck CHECK (version > 0)
);

ALTER TABLE batch_document_management ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_document_management FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_document_management
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_document_management FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_document_management TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHDOCMGMT.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Activate document management for batches. ODOC is a search alias only. The indicator does not create a document or a link.'
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
  'CFG.INV.BATCHDOCMGMT.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Activate document management for batches',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'A client indicator for the batch-master documents tab, without a document',
  969,
  'STANDARD',
  '/config/batch-document-management',
  true,
  'MIGRATION_9144'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9144',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHDOCMGMT.DEFINE', 'NOT_STARTED', 'MIGRATION_9144'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHDOCMGMT.DEFINE',
  NULL,
  'Activate document management for batches',
  'CONFIG_ACTIVITY',
  'INV',
  $odoc$Activate document management for batches. ODOC is a search alias only. The stored code is TCUCD-KZDCD: X when active, blank when not active. A missing row is not active. Activation makes the documents tab visible on the batch master. Deactivation hides that tab. A batch, a document, and a link are not deleted. No document info record is created, and no file is stored. CV01N, MB56, MB57, and MB5C are not this screen. A goods movement does not create an attachment because this indicator is on. A closed posting period does not block this screen. Opening this screen writes nothing.$odoc$,
  'TIER_2_CONFIGURED',
  '/config/batch-document-management',
  'B',
  'MIGRATION_9144'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9144',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'ODOC', 'SEARCH_ONLY', 'MIGRATION_9144'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHDOCMGMT.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHDOCMGMT.DEFINE', 'MIGRATION_9144'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.INV.BATCHCONVERT.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;
