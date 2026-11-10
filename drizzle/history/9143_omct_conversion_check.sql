-- OMCT records a conversion check. It does not change the batch level,
-- the status indicator, a batch, stock, or a material document.
-- No conversion program is seeded, and no batch is merged.

CREATE TABLE IF NOT EXISTS batch_conversion_check (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  check_id varchar(36) NOT NULL,
  proposal varchar(12) NOT NULL,
  source_level char(1) NOT NULL,
  target_level char(1) NOT NULL,
  source_status char(1) NOT NULL,
  target_status char(1) NOT NULL,
  result varchar(16) NOT NULL,
  batch_count integer NOT NULL,
  stock_batch_count integer NOT NULL,
  document_batch_count integer NOT NULL,
  conflict_count integer NOT NULL,
  summary text NOT NULL,
  reason varchar(500) NOT NULL,
  started_by varchar(60) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, check_id),
  CONSTRAINT batch_conversion_check_proposal_ck CHECK (proposal in ('LEVEL', 'STATUS', 'BOTH')),
  CONSTRAINT batch_conversion_check_level_ck CHECK (source_level in ('0', '1', '2') and target_level in ('0', '1', '2')),
  CONSTRAINT batch_conversion_check_status_ck CHECK (source_status in ('1', ' ') and target_status in ('1', ' ')),
  CONSTRAINT batch_conversion_check_result_ck CHECK (result in ('BLOCKED', 'NOT_REQUIRED'))
);

CREATE TABLE IF NOT EXISTS batch_conversion_conflict (
  client varchar(4) NOT NULL,
  check_id varchar(36) NOT NULL,
  position integer NOT NULL,
  conflict_code varchar(32) NOT NULL,
  object_key varchar(80) NOT NULL,
  detail varchar(240) NOT NULL,
  blocks boolean NOT NULL,
  PRIMARY KEY (client, check_id, position),
  CONSTRAINT batch_conversion_conflict_fk
    FOREIGN KEY (client, check_id)
    REFERENCES batch_conversion_check (client, check_id)
    ON DELETE CASCADE,
  CONSTRAINT batch_conversion_conflict_position_ck CHECK (position > 0)
);

ALTER TABLE batch_conversion_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_conversion_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_conversion_check
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_conversion_check FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_conversion_check TO cairn_app;

ALTER TABLE batch_conversion_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_conversion_conflict FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_conversion_conflict
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_conversion_conflict FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_conversion_conflict TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHCONVERT.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Check a batch-level or batch-status conversion. OMCT is a search alias only. The check does not change the level, the status, or a batch.'
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
  'CFG.INV.BATCHCONVERT.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Batch level and status conversion',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'A conversion check, without changing the level or the status',
  968,
  'STANDARD',
  '/config/batch-conversion',
  true,
  'MIGRATION_9143'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9143',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHCONVERT.DEFINE', 'NOT_STARTED', 'MIGRATION_9143'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHCONVERT.DEFINE',
  NULL,
  'Batch level and status conversion',
  'CONFIG_ACTIVITY',
  'INV',
  $omct$Batch level and status conversion check. OMCT is a search alias only. It is not OMCE and not OMCS. The current level and status are shown. A proposed target is checked for duplicate batch identities, a missing plant, stock, material documents, the other batch class type, a restricted-use indicator, and a plant status selection. A dry run writes nothing. A confirmed check records the finding and does not change the level, the status, a batch, stock, or a document. Two batches are not merged. Movements 341 and 342 are not posted. Live conversion is not available. A closed posting period does not block the check. Opening this screen writes nothing.$omct$,
  'TIER_2_CONFIGURED',
  '/config/batch-conversion',
  'B',
  'MIGRATION_9143'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9143',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCT', 'SEARCH_ONLY', 'MIGRATION_9143'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHCONVERT.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHCONVERT.DEFINE', 'MIGRATION_9143'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.INV.BATCHSTATUS.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;
