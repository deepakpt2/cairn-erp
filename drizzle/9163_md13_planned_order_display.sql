-- MD13. Display a planned order. No new order column.
-- Display writes nothing, firms nothing, and does not infer conversion.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.PLANNEDORDER.DISPLAY',
  'PROD',
  'DISPLAY',
  false,
  'Display a planned order. MD13 is a search alias. Display writes nothing, takes no change lock, and does not firm, convert, or delete the order.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'PROD.PLANNEDORDER.DISPLAY', 'MIGRATION_9163'
FROM role_capability rc
WHERE rc.capability_code IN ('PROD.MRP.RUN', 'PROD.MRP.STOCKREQ')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.PLANNEDORDER.DISPLAY',
  'planned_order',
  'Display planned order',
  'TRANSACTION',
  'PROD',
  'Display a planned order. MD13 is a search alias. The number is the key. Quantity, unit, start, finish, and firming are shown as stored. An MRP area, an order type, a special procurement key, an opening date, a production version, a BOM, a routing, a scheduler, a storage location, a sales order, a WBS element, and a deletion flag are not stored. Conversion is not inferred. Display writes nothing and takes no change lock.',
  'TIER_1_BUILT',
  '/production/planned-order-display',
  'B',
  'MIGRATION_9163'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9163',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MD13', 'SEARCH_ONLY', 'MIGRATION_9163'
FROM term_registry t
WHERE t.our_code = 'PROD.PLANNEDORDER.DISPLAY'
ON CONFLICT (external_system, alias) DO NOTHING;
