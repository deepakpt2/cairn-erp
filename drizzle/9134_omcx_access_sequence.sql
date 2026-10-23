-- OMCX stores an Inventory Management access sequence.
-- Usage is H and application is ME, the VV_T682_ME scope.
-- Access steps are not columns. No condition table stands.
-- A strategy type may name a standing sequence. The name does not run an access.

CREATE TABLE IF NOT EXISTS batch_access_sequence (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  access_sequence varchar(4) NOT NULL,
  description varchar(30) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage, application, access_sequence),
  CONSTRAINT batch_access_sequence_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_access_sequence_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_access_sequence_key_ck CHECK (access_sequence ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT batch_access_sequence_version_ck CHECK (version > 0)
);

ALTER TABLE batch_access_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_access_sequence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_access_sequence
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_access_sequence FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_access_sequence TO cairn_app;

ALTER TABLE batch_strategy_type
  ADD COLUMN IF NOT EXISTS access_sequence varchar(4) NOT NULL DEFAULT '';

ALTER TABLE batch_strategy_type
  DROP CONSTRAINT IF EXISTS batch_strategy_type_access_ck;

ALTER TABLE batch_strategy_type
  ADD CONSTRAINT batch_strategy_type_access_ck
  CHECK (access_sequence = '' OR access_sequence ~ '^[A-Z0-9]{1,4}$');

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHACCESS.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Define Inventory Management access sequences. OMCX is a search alias only. Usage is H and application is ME. The key is four characters. An access step is not stored. It does not find a condition record or select a batch.'
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
  'CFG.INV.BATCHACCESS.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Inventory Management access sequences',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'An access sequence for Inventory Management, without a condition table',
  961,
  'STANDARD',
  '/config/batch-access-sequences',
  true,
  'MIGRATION_9134'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9134',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHACCESS.DEFINE', 'NOT_STARTED', 'MIGRATION_9134'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHACCESS.DEFINE', 'MIGRATION_9134'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  'CFG.INV.BATCHCLASSIFY.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHACCESS.DEFINE',
  NULL,
  'Inventory Management access sequences',
  'CONFIG_ACTIVITY',
  'INV',
  $omcx$Inventory Management access sequences. OMCX is a search alias only. The view is VV_T682_ME. Usage is H and application is ME. The key is four uppercase letters or digits. The description is at most thirty characters. An access step, a condition table, an exclusive indicator, and a requirement are not stored. No condition table stands. A strategy type may name a standing sequence, and that name does not run an access or select a batch. Production and sales access sequences are not this screen. A transport and a plant are refused. Opening this screen writes nothing.$omcx$,
  'TIER_2_CONFIGURED',
  '/config/batch-access-sequences',
  'B',
  'MIGRATION_9134'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9134',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCX', 'SEARCH_ONLY', 'MIGRATION_9134'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHACCESS.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

UPDATE term_registry
SET description = $omcw$Inventory Management strategy types. OMCW is a search alias only. The view is VV_T685H_ME. Usage is H and application is ME. The key is the condition type, one to four uppercase letters or digits. The description is at most twenty characters. An access sequence is optional and must already stand on OMCX. Naming it does not run an access. Selection classes, sort rules, quantity-proposal exits, and batch splits are not stored. Class type 023 is not active. A strategy type does not select a batch. A transport and a plant are refused. Opening this screen writes nothing.$omcw$,
    changed_by = 'MIGRATION_9134',
    changed_at = now()
WHERE our_code = 'CFG.INV.BATCHSTRATEGY.DEFINE';
