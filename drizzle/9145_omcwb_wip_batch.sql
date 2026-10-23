-- OMCWB stores the client indicator for WIP batch.
-- The SAP field is TCUWIPB-WIPBATCH_ACTIVE, domain XFELD.
-- X is active. Blank is not active. Once active, the indicator cannot be revoked.
-- Saving it does not create a WIP batch, a production order, or a material document.

CREATE TABLE IF NOT EXISTS wip_batch_activation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  wip_batch_active char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client),
  CONSTRAINT wip_batch_activation_code_ck CHECK (wip_batch_active in ('X', ' ')),
  CONSTRAINT wip_batch_activation_version_ck CHECK (version > 0)
);

ALTER TABLE wip_batch_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wip_batch_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wip_batch_activation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON wip_batch_activation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON wip_batch_activation TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROD.WIPBATCH.DEFINE',
  'PP',
  'CONFIGURE',
  false,
  'Activate WIP batch. OMCWB is a search alias only. The indicator cannot be revoked. It does not create a WIP batch.'
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
  'CFG.PROD.WIPBATCH.DEFINE',
  'PRODUCTION',
  NULL,
  'Activate WIP batch',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'A client indicator for WIP batch, without creating a batch',
  970,
  'STANDARD',
  '/config/wip-batch',
  true,
  'MIGRATION_9145'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9145',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.WIPBATCH.DEFINE', 'NOT_STARTED', 'MIGRATION_9145'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROD.WIPBATCH.DEFINE',
  NULL,
  'Activate WIP batch',
  'CONFIG_ACTIVITY',
  'PP',
  $omcwb$Activate WIP batch. OMCWB is a search alias only. The stored code is TCUWIPB-WIPBATCH_ACTIVE: X when active, blank when not active. A missing row is not active. Activation requires a batch level and an explicit confirmation. Once X is saved it cannot be revoked. The save does not create a WIP batch, a production order, a confirmation, or a material document. Business function LOG_PP_WIP_BATCH, original-batch reference material, a confirmation profile, and a control key are not this screen. A closed posting period does not block it. Opening this screen writes nothing.$omcwb$,
  'TIER_2_CONFIGURED',
  '/config/wip-batch',
  'B',
  'MIGRATION_9145'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9145',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCWB', 'SEARCH_ONLY', 'MIGRATION_9145'
FROM term_registry t
WHERE t.our_code = 'CFG.PROD.WIPBATCH.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.PROD.WIPBATCH.DEFINE', 'MIGRATION_9145'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.PROD.SCHEDPROFILE.DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;
