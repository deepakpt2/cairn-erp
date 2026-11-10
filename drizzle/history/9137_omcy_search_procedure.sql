-- OMCY stores an Inventory Management search procedure.
-- Usage is H and application is ME. The key is six characters.
-- A step names a standing strategy type. It does not select a batch.
-- A movement type is not assigned here.

CREATE TABLE IF NOT EXISTS batch_search_procedure (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  search_procedure varchar(6) NOT NULL,
  description varchar(30) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage, application, search_procedure),
  CONSTRAINT batch_search_procedure_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_search_procedure_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_search_procedure_key_ck CHECK (search_procedure ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT batch_search_procedure_version_ck CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS batch_search_procedure_step (
  client varchar(4) NOT NULL,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  search_procedure varchar(6) NOT NULL,
  step_number char(3) NOT NULL,
  counter char(2) NOT NULL,
  strategy_type varchar(4) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage, application, search_procedure, step_number, counter),
  CONSTRAINT batch_search_procedure_step_header_fk
    FOREIGN KEY (client, usage, application, search_procedure)
    REFERENCES batch_search_procedure (client, usage, application, search_procedure)
    ON DELETE CASCADE,
  CONSTRAINT batch_search_procedure_step_type_fk
    FOREIGN KEY (client, usage, application, strategy_type)
    REFERENCES batch_strategy_type (client, usage, application, strategy_type),
  CONSTRAINT batch_search_procedure_step_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_search_procedure_step_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_search_procedure_step_number_ck CHECK (step_number ~ '^[0-9]{3}$'),
  CONSTRAINT batch_search_procedure_step_counter_ck CHECK (counter ~ '^[0-9]{2}$'),
  CONSTRAINT batch_search_procedure_step_type_ck CHECK (strategy_type ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT batch_search_procedure_step_version_ck CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS batch_search_procedure_step_type_idx
  ON batch_search_procedure_step (client, usage, application, strategy_type);

ALTER TABLE batch_search_procedure ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_search_procedure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_search_procedure
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_search_procedure FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_search_procedure TO cairn_app;

ALTER TABLE batch_search_procedure_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_search_procedure_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_search_procedure_step
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_search_procedure_step FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_search_procedure_step TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHSEARCH.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Define Inventory Management search procedures. OMCY is a search alias only. Usage is H and application is ME. The key is six characters. A step names a standing strategy type. It does not select a batch or assign a movement type.'
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
  'CFG.INV.BATCHSEARCH.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Inventory Management search procedures',
  'DEFINE',
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  'A search procedure for Inventory Management, without selecting a batch',
  963,
  'STANDARD',
  '/config/batch-search-procedures',
  true,
  'MIGRATION_9137'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9137',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHSEARCH.DEFINE', 'NOT_STARTED', 'MIGRATION_9137'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHSEARCH.DEFINE', 'MIGRATION_9137'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  'CFG.INV.BATCHACCESS.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHSEARCH.DEFINE',
  NULL,
  'Inventory Management search procedures',
  'CONFIG_ACTIVITY',
  'INV',
  $omcy$Inventory Management search procedures. OMCY is a search alias only. Usage is H and application is ME. The key is one to six uppercase letters or digits. The description is at most thirty characters. A step names a strategy type that already stands on OMCW. The step number is three digits and the counter is two digits. Neither need be gap-free. Naming a strategy type does not select a batch. A requirement, a manual indicator, and a movement-type allocation are not stored. Production and sales search procedures are not this screen. A transport and a plant are refused. Opening this screen writes nothing.$omcy$,
  'TIER_2_CONFIGURED',
  '/config/batch-search-procedures',
  'B',
  'MIGRATION_9137'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9137',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCY', 'SEARCH_ONLY', 'MIGRATION_9137'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHSEARCH.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
