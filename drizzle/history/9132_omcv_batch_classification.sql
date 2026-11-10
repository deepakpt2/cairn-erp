-- OMCV stores KZCLA on the standing movement type.
-- Blank is no branching. 1, 2, 3, and 4 ask for classification.
-- Existing rows stay blank, so a current posting is not changed.
-- Copying, WIP adoption, and extended CFC are not columns.
-- Class type 023 is not activated. No classification value is written.

ALTER TABLE movement_type
  ADD COLUMN IF NOT EXISTS batch_classification char(1) NOT NULL DEFAULT ' ';

ALTER TABLE movement_type
  DROP CONSTRAINT IF EXISTS movement_type_batch_classification_ck;

ALTER TABLE movement_type
  ADD CONSTRAINT movement_type_batch_classification_ck
  CHECK (batch_classification IN (' ', '1', '2', '3', '4'));

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHCLASSIFY.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Set batch classification for a goods movement. OMCV is a search alias only. Blank does not branch. A non-blank code cannot classify while class type 023 is inactive, so the posting is refused. Copying is not stored.'
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
  'CFG.INV.BATCHCLASSIFY.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Batch classification for goods movements',
  'DEFINE',
  'CFG.INV.MOVETYPE.CONFIG',
  'Classification control on the standing movement type',
  959,
  'STANDARD',
  '/config/batch-classification',
  true,
  'MIGRATION_9132'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9132',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHCLASSIFY.DEFINE', 'NOT_STARTED', 'MIGRATION_9132'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHCLASSIFY.DEFINE', 'MIGRATION_9132'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.MOVETYPE.CONFIG',
  'CFG.INV.BATCHSTATUS.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHCLASSIFY.DEFINE',
  NULL,
  'Batch classification for goods movements',
  'CONFIG_ACTIVITY',
  'INV',
  $omcv$Batch classification for goods movements. OMCV is a search alias only. The control is KZCLA on the standing movement type. Blank is no branching. 1 is background for all batches. 2 is foreground for mandatory characteristics, all batches. 3 is always foreground, all batches. 4 is foreground for new batches only. A non-blank code cannot classify while class type 023 is inactive, so the goods movement is refused before stock or a journal. Characteristic copying, WIP-batch adoption, and extended CFC are not stored and are not functional. A posted movement is not rewritten. This screen does not create a movement type and does not change its posting rules. A transport and a plant are refused. Opening this screen writes nothing.$omcv$,
  'TIER_2_CONFIGURED',
  '/config/batch-classification',
  'B',
  'MIGRATION_9132'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9132',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCV', 'SEARCH_ONLY', 'MIGRATION_9132'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHCLASSIFY.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
