-- OMCE stores one batch level for the client. The stored code is the SAP
-- character, never a number: 0 plant, 1 material, 2 client. It does not
-- activate batch status, internal numbering, or a batch number range, and
-- it does not post. A closed period does not belong on this screen.

CREATE TABLE batch_level_configuration (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  batch_level char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client),
  CONSTRAINT batch_level_configuration_level_ck CHECK (batch_level IN ('0', '1', '2')),
  CONSTRAINT batch_level_configuration_version_ck CHECK (version > 0)
);

CREATE TABLE batch_level_conversion (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  conversion_run_id varchar(36) NOT NULL,
  source_level char(1) NOT NULL,
  target_level char(1) NOT NULL,
  source_version integer NOT NULL,
  status varchar(24) NOT NULL,
  batch_count integer NOT NULL,
  stock_batch_count integer NOT NULL,
  document_batch_count integer NOT NULL,
  stock_column_present boolean NOT NULL,
  document_column_present boolean NOT NULL,
  error_summary text NOT NULL,
  reason varchar(500) NOT NULL,
  started_by varchar(60) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, conversion_run_id),
  CONSTRAINT batch_level_conversion_status_ck CHECK (status IN ('BLOCKED', 'NOT_REQUIRED')),
  CONSTRAINT batch_level_conversion_level_ck CHECK (
    source_level IN ('0', '1', '2') AND target_level IN ('0', '1', '2')
  ),
  CONSTRAINT batch_level_conversion_counts_ck CHECK (
    batch_count >= 0 AND stock_batch_count >= 0 AND document_batch_count >= 0
  )
);

-- Identity rows a later batch master will write. OMCE does not open that
-- screen. The partial indexes are the three SAP uniqueness rules. A level
-- change is refused while any row stands, so mixed identity is not stored.
CREATE TABLE batch (
  id varchar(36) NOT NULL,
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  batch_number varchar(40) NOT NULL,
  material_number varchar(40) NOT NULL,
  plant varchar(10),
  batch_level_at_creation char(1) NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT batch_client_material_fk
    FOREIGN KEY (client, material_number)
    REFERENCES material (client, material_number)
    ON DELETE RESTRICT,
  CONSTRAINT batch_client_plant_fk
    FOREIGN KEY (client, plant)
    REFERENCES plant (client, plant)
    ON DELETE RESTRICT,
  CONSTRAINT batch_level_ck CHECK (batch_level_at_creation IN ('0', '1', '2')),
  CONSTRAINT batch_number_ck CHECK (char_length(btrim(batch_number)) BETWEEN 1 AND 40),
  CONSTRAINT batch_identity_ck CHECK (
    (batch_level_at_creation = '0' AND plant IS NOT NULL)
    OR (batch_level_at_creation IN ('1', '2') AND plant IS NULL)
  )
);

CREATE UNIQUE INDEX batch_plant_level_uq
  ON batch (client, material_number, plant, batch_number)
  WHERE batch_level_at_creation = '0';

CREATE UNIQUE INDEX batch_material_level_uq
  ON batch (client, material_number, batch_number)
  WHERE batch_level_at_creation = '1';

CREATE UNIQUE INDEX batch_client_level_uq
  ON batch (client, batch_number)
  WHERE batch_level_at_creation = '2';

CREATE INDEX batch_client_idx ON batch (client);

ALTER TABLE batch_level_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_level_configuration FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_level_configuration
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_level_configuration FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_level_configuration TO cairn_app;

ALTER TABLE batch_level_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_level_conversion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_level_conversion
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_level_conversion FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_level_conversion TO cairn_app;

ALTER TABLE batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHLEVEL.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Define the batch level for the client. OMCE is a search alias only. The stored code is 0, 1, or 2.'
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
  'CFG.INV.BATCHLEVEL.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Define batch level',
  'DEFINE',
  '',
  'Batch identity for a later batch master',
  920,
  'STANDARD',
  '/config/batch-level',
  true,
  'MIGRATION_9110'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9110',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHLEVEL.DEFINE', 'NOT_STARTED', 'MIGRATION_9110'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHLEVEL.DEFINE', 'MIGRATION_9110'
FROM role_capability rc
WHERE rc.capability_code IN (
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
  'CFG.INV.BATCHLEVEL.DEFINE',
  NULL,
  'Define batch level',
  'CONFIG_ACTIVITY',
  'INV',
  $omce$Define the batch level for the client. OMCE is a search alias only. One row stands per client. The stored code is the character 0, 1, or 2, never a number and never a label: 0 is unique for a material in a plant, 1 is unique for a material in the client, and 2 is unique once in the client. The description is derived. An initial level is saved only when no batch stands. A later change sends the opened version. If a batch stands, the row is not edited and a conversion is not presented as a save. Live conversion is refused by name because stock and material documents do not yet carry a batch. Setting the level does not activate batch status, internal numbering, classification, or a batch requirement on a movement. A closed posting period does not block this screen. A transport, an approval, and a company code are refused by name. The change document is the history. The lock is the configuration row.$omce$,
  'TIER_2_CONFIGURED',
  '/config/batch-level',
  'B',
  'MIGRATION_9110'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9110',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCE', 'SEARCH_ONLY', 'MIGRATION_9110'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHLEVEL.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
