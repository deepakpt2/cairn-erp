-- MD12. Change a planned order. No new order column.
-- A change of quantity or dates firms the order. Change does not convert it.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.PLANNEDORDER.CHANGE',
  'PROD',
  'CHANGE',
  false,
  'Change a planned order. MD12 is a search alias. The number, material, and plant stay fixed. A change of quantity or dates firms the order. Change does not convert the order and posts nothing.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'PROD.PLANNEDORDER.CHANGE', 'MIGRATION_9164'
FROM role_capability rc
WHERE rc.capability_code = 'PROD.MRP.RUN'
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.PLANNEDORDER.CHANGE',
  NULL,
  'Change planned order',
  'TRANSACTION',
  'PROD',
  'Change a planned order. MD12 is a search alias. The number, material, plant, and origin stay fixed. Quantity, dates, and firming can change. A change of quantity or dates firms the order. An MRP area, an order type, a special procurement key, an opening date, a production version, a BOM, a routing, a scheduler, a storage location, a sales order, a WBS element, and a deletion flag are not stored. Change does not convert the order and posts nothing.',
  'TIER_1_BUILT',
  '/production/planned-order-change',
  'B',
  'MIGRATION_9164'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9164',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MD12', 'SEARCH_ONLY', 'MIGRATION_9164'
FROM term_registry t
WHERE t.our_code = 'PROD.PLANNEDORDER.CHANGE'
ON CONFLICT (external_system, alias) DO NOTHING;
