-- OMJJ maintains the standing movement_type row. The activity was already
-- declared in seed; a provisioned database that has not been reseeded does not
-- carry it, so the workbench cannot open the screen. This brings that registry
-- to the same end state a fresh seed produces. It does not add a second
-- catalogue table, and it does not post stock.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.MOVETYPE.CONFIG',
  'INV',
  'CONFIGURE',
  false,
  'Configure movement types: the catalogue goods movements already read, maintained without posting stock or a journal and without a posting-period check'
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
  'CFG.INV.MOVETYPE.CONFIG',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Configure movement types',
  'DEFINE',
  'CFG.FIN.ACCTDET.DEFINE',
  'Goods movements with accounting',
  610,
  'ONBOARDING',
  '/config/movement-types',
  true,
  'MIGRATION_9103'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9103',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.MOVETYPE.CONFIG', 'NOT_STARTED', 'MIGRATION_9103'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.MOVETYPE.CONFIG',
  NULL,
  'Configure movement types',
  'CONFIG_ACTIVITY',
  'INV',
  $omjj$Configure movement types: the catalogue goods movements already read. The key is the catalogue identity; a three-digit alias is not stored. Direction, reference, reversal, stock types, plant and location rules, valuation and the account-determination event and modifier are the policies. The modifier is not a G/L account. A company code, a draft, a version, a policy, a field-selection profile, a two-step movement, batch, serial and special stock are refused by name. A movement a document or a reservation already cites keeps its posting rules. This screen posts no stock and no journal, and a closed posting period does not block it.$omjj$,
  'TIER_2_CONFIGURED',
  '/config/movement-types',
  'B',
  'MIGRATION_9103'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9103',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMJJ', 'SEARCH_ONLY', 'MIGRATION_9103'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.MOVETYPE.CONFIG'
ON CONFLICT (external_system, alias) DO NOTHING;
