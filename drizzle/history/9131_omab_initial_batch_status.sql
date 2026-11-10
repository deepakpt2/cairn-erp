-- OMAB sets T134-IZUST on the existing material type. True is X, false is blank.
-- The column already stands. This migration does not rewrite a batch or a type.
-- Opening the screen does not select a type. It does not post stock.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHINITIAL.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Set the initial status of a new batch by material type. OMAB is a search alias only. X restricts a future batch. Blank does not. It does not rewrite an existing batch or post stock.'
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
  'CFG.INV.BATCHINITIAL.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Initial status of a new batch',
  'DEFINE',
  'CFG.INV.MATERIALTYPE.DEFINE',
  'Initial restricted or unrestricted status for a new batch',
  958,
  'STANDARD',
  '/config/batch-initial-status',
  true,
  'MIGRATION_9131'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9131',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHINITIAL.DEFINE', 'NOT_STARTED', 'MIGRATION_9131'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHINITIAL.DEFINE', 'MIGRATION_9131'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHSTATUS.DEFINE',
  'CFG.INV.MATERIALTYPE.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHINITIAL.DEFINE',
  NULL,
  'Initial status of a new batch',
  'CONFIG_ACTIVITY',
  'INV',
  $omab$Initial status of a new batch. OMAB is a search alias only. The flag is the material type, not a plant. Checked is stored as restricted for a new batch. Blank is unrestricted. An existing batch is not rewritten. This screen does not create a material type, post stock, or change the client status indicator. Restricted use is not blocked stock and not inspection stock. A transport is refused. Opening this screen writes nothing.$omab$,
  'TIER_2_CONFIGURED',
  '/config/batch-initial-status',
  'B',
  'MIGRATION_9131'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9131',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMAB', 'SEARCH_ONLY', 'MIGRATION_9131'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHINITIAL.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
