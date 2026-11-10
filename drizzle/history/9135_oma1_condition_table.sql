-- OMA1 stores an Inventory Management condition table.
-- Usage is H and application is ME. The number is the customer key area, 501 to 999.
-- The SAP key area is not seeded. No physical table is generated.
-- A field row is the key, in the order it was named. No condition record is stored.

CREATE TABLE IF NOT EXISTS batch_condition_table (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  condition_table char(3) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage, condition_table),
  CONSTRAINT batch_condition_table_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_condition_table_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_condition_table_number_ck CHECK (condition_table ~ '^(50[1-9]|5[1-9][0-9]|[6-9][0-9]{2})$'),
  CONSTRAINT batch_condition_table_version_ck CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS batch_condition_table_field (
  client varchar(4) NOT NULL,
  usage char(1) NOT NULL DEFAULT 'H',
  condition_table char(3) NOT NULL,
  position integer NOT NULL,
  field_name varchar(30) NOT NULL,
  PRIMARY KEY (client, usage, condition_table, position),
  CONSTRAINT batch_condition_table_field_header_fk
    FOREIGN KEY (client, usage, condition_table)
    REFERENCES batch_condition_table (client, usage, condition_table)
    ON DELETE CASCADE,
  CONSTRAINT batch_condition_table_field_position_ck CHECK (position BETWEEN 1 AND 9),
  CONSTRAINT batch_condition_table_field_name_ck CHECK (field_name in (
    'BWART', 'KUNNR', 'LGORT', 'LIFNR', 'MATKL', 'MATNR', 'MTART', 'SOBKZ', 'WERKS'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS batch_condition_table_field_name_uk
  ON batch_condition_table_field (client, usage, condition_table, field_name);

ALTER TABLE batch_condition_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_condition_table FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_condition_table
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_condition_table FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_condition_table TO cairn_app;

ALTER TABLE batch_condition_table_field ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_condition_table_field FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_condition_table_field
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_condition_table_field FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_condition_table_field TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHCONDTABLE.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Define Inventory Management condition tables. OMA1 is a search alias only. Usage is H and application is ME. The number is 501 to 999. The key fields are stored. No physical table is generated, and no condition record is stored.'
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
  'CFG.INV.BATCHCONDTABLE.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Inventory Management condition tables',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'A condition table for Inventory Management, without a condition record',
  962,
  'STANDARD',
  '/config/batch-condition-tables',
  true,
  'MIGRATION_9135'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9135',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHCONDTABLE.DEFINE', 'NOT_STARTED', 'MIGRATION_9135'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHCONDTABLE.DEFINE', 'MIGRATION_9135'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHACCESS.DEFINE',
  'CFG.INV.BATCHSTRATEGY.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHCONDTABLE.DEFINE',
  NULL,
  'Inventory Management condition tables',
  'CONFIG_ACTIVITY',
  'INV',
  $oma1$Inventory Management condition tables. OMA1 is a search alias only. Change and display are the same screen. Usage is H and application is ME. The number is three digits from 501 to 999. The SAP key area, 001 to 500, is refused and is not seeded. The key fields are the Inventory Management list: movement type, customer, storage location, supplier, material group, material, material type, special stock, and plant. A field outside that list is refused. No physical table is generated. No condition record is stored. An access sequence does not search this table, and a goods movement is not changed. Production and sales condition tables are not this screen. A transport and a plant value are refused. Opening this screen writes nothing.$oma1$,
  'TIER_2_CONFIGURED',
  '/config/batch-condition-tables',
  'B',
  'MIGRATION_9135'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9135',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMA1', 'SEARCH_ONLY', 'MIGRATION_9135'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHCONDTABLE.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

UPDATE term_registry
SET description = $omcx$Inventory Management access sequences. OMCX is a search alias only. The view is VV_T682_ME. Usage is H and application is ME. The key is four uppercase letters or digits. The description is at most thirty characters. An access step, an exclusive indicator, and a requirement are not stored. A condition table is maintained on OMA1 and is not searched here. A strategy type may name a standing sequence, and that name does not run an access or select a batch. Production and sales access sequences are not this screen. A transport and a plant are refused. Opening this screen writes nothing.$omcx$,
    changed_by = 'MIGRATION_9135',
    changed_at = now()
WHERE our_code = 'CFG.INV.BATCHACCESS.DEFINE';
