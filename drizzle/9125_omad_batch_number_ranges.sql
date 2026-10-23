-- OMAD maintains intervals for BATCH_CLT. It does not create interval 01,
-- a batch, or a stock receipt. The intervals stay on the existing
-- number_range table. This migration registers the screen only.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHRANGE.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Maintain BATCH_CLT intervals. OMAD is a search alias only. It does not create a batch, and it does not post.'
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
  'CFG.INV.BATCHRANGE.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Number ranges for batch numbers',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'Intervals for BATCH_CLT, without creating a batch',
  950,
  'STANDARD',
  '/config/batch-number-ranges',
  true,
  'MIGRATION_9125'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9125',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHRANGE.DEFINE', 'NOT_STARTED', 'MIGRATION_9125'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHRANGE.DEFINE', 'MIGRATION_9125'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHNUMBER.DEFINE',
  'CFG.INV.BATCHSTATUS.DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.PLT.NUMBERRANGE.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHRANGE.DEFINE',
  NULL,
  'Number ranges for batch numbers',
  'CONFIG_ACTIVITY',
  'INV',
  $omad$Number ranges for batch numbers. OMAD is a search alias only. The object is BATCH_CLT, client level, not a plant and not a material type. Interval 01 is internal. Interval 02, when it stands and is external, checks a typed number and does not allocate. Opening this screen does not create an interval, a batch, or a stock receipt. From, to, and the current number are shown with leading zeros. The current number is the last issued number. The next number is not reserved by being shown. It is not moved backwards. A number is not reissued. Exhaustion does not wrap. Gaps are acceptable. Buffering is refused. Delete is allowed only when nothing has been issued and no standing batch falls in the interval. A closed posting period does not block this screen. A transport, a company code, and a fiscal year are refused by name. The change document is the history. The lock is the interval.$omad$,
  'TIER_2_CONFIGURED',
  '/config/batch-number-ranges',
  'B',
  'MIGRATION_9125'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9125',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMAD', 'SEARCH_ONLY', 'MIGRATION_9125'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHRANGE.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

UPDATE term_registry
SET description = 'Activate internal batch number assignment. OMCZ is a search alias only. The client flag is X when active and blank when not active. It is not a plant and not a material type. A separate plant flag permits an internal number only for an account-assigned goods receipt. That receipt is not posted here. The number range is BATCH_CLT interval 01, maintained in OMAD. This screen does not create the interval, a batch, or a stock receipt. A closed posting period does not block it. A transport is refused by name.',
    changed_by = 'MIGRATION_9125',
    changed_at = now()
WHERE our_code = 'CFG.INV.BATCHNUMBER.DEFINE';
