-- OMCW stores an Inventory Management strategy type.
-- Usage is H and application is ME, the VV_T685H_ME scope.
-- Access sequences, selection classes, sort rules, and quantity exits are not columns.
-- Opening this screen writes nothing. A strategy type does not select a batch.

CREATE TABLE IF NOT EXISTS batch_strategy_type (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  strategy_type varchar(4) NOT NULL,
  description varchar(20) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage, application, strategy_type),
  CONSTRAINT batch_strategy_type_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_strategy_type_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_strategy_type_key_ck CHECK (strategy_type ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT batch_strategy_type_version_ck CHECK (version > 0)
);

ALTER TABLE batch_strategy_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_strategy_type FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_strategy_type
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_strategy_type FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_strategy_type TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Define Inventory Management strategy types. OMCW is a search alias only. Usage is H and application is ME. The key is the condition type. It does not select a batch or post stock.'
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
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Inventory Management strategy types',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'A strategy type for Inventory Management, without selecting a batch',
  960,
  'STANDARD',
  '/config/batch-strategy-types',
  true,
  'MIGRATION_9133'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9133',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHSTRATEGY.DEFINE', 'NOT_STARTED', 'MIGRATION_9133'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHSTRATEGY.DEFINE', 'MIGRATION_9133'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHCLASSIFY.DEFINE',
  'CFG.INV.MOVETYPE.CONFIG',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  NULL,
  'Inventory Management strategy types',
  'CONFIG_ACTIVITY',
  'INV',
  $omcw$Inventory Management strategy types. OMCW is a search alias only. The view is VV_T685H_ME. Usage is H and application is ME. The key is the condition type, one to four uppercase letters or digits. The description is at most twenty characters. Access sequences, selection classes, sort rules, quantity-proposal exits, and batch splits are not stored and are not functional. Class type 023 is not active. A strategy type does not select a batch, and a goods movement is not changed. Production and sales strategy types are not this screen. A transport and a plant are refused. Opening this screen writes nothing.$omcw$,
  'TIER_2_CONFIGURED',
  '/config/batch-strategy-types',
  'B',
  'MIGRATION_9133'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9133',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCW', 'SEARCH_ONLY', 'MIGRATION_9133'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHSTRATEGY.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
