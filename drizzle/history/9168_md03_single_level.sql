-- MD03. Single-item, single-level planning.
-- The plant run and MD02 stay as they are. A lower-level component is not planned.
-- Delete and recreate is not a stored mode. An MRP list is not a table.

ALTER TABLE mrp_run DROP CONSTRAINT IF EXISTS mrp_run_entry_ck;
ALTER TABLE mrp_run ADD CONSTRAINT mrp_run_entry_ck CHECK (entry_point IN ('PLANT', 'SINGLE_ITEM', 'SINGLE_LEVEL'));

ALTER TABLE mrp_run DROP CONSTRAINT IF EXISTS mrp_run_mode_ck;
ALTER TABLE mrp_run ADD CONSTRAINT mrp_run_mode_ck CHECK (planning_mode IN ('ADAPT_EXISTING', 'REEXPLODE'));

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.MRP.SINGLELEVEL',
  'PROD',
  'EXECUTE',
  false,
  'Plan one material at one level. MD03 is a search alias. A lower-level component is not planned. The run posts nothing.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'PROD.MRP.SINGLELEVEL', 'MIGRATION_9168'
FROM role_capability rc
WHERE rc.capability_code = 'PROD.MRP.RUN'
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.MRP.SINGLELEVEL',
  NULL,
  'Single-level planning',
  'TRANSACTION',
  'PROD',
  'Plan one material in one plant and do not plan a lower-level component. MD03 is a search alias. Adapt existing does not explode. Re-explode writes dependent requirements and does not plan the component. Delete and recreate is refused. An MRP area, a scheduling-agreement schedule line, an MRP list, and a creation indicator are refused. A check writes nothing. The run posts nothing.',
  'TIER_1_BUILT',
  '/production/single-level-planning',
  'B',
  'MIGRATION_9168'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9168',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MD03', 'SEARCH_ONLY', 'MIGRATION_9168'
FROM term_registry t
WHERE t.our_code = 'PROD.MRP.SINGLELEVEL'
ON CONFLICT (external_system, alias) DO NOTHING;
