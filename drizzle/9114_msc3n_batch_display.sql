-- MSC3N displays the existing batch row. It adds no table, no index,
-- and no deletion flag. The lookup already follows the batch level.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCH.DISPLAY',
  'INV',
  'DISPLAY',
  false,
  'Display a batch master. MSC3N is a search alias only. Displaying a batch does not change it and does not post.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCH.DISPLAY', 'MIGRATION_9114'
FROM role_capability rc
WHERE rc.capability_code IN ('INV.BATCH.CHANGE', 'INV.BATCH.CREATE', 'INV.MATERIAL.MAINTAIN', 'INV.STOCK.VIEW')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'INV.BATCH.DISPLAY',
  NULL,
  'Display batch',
  'TRANSACTION',
  'INV',
  $msc3n$Display a batch master. MSC3N is a search alias only. The batch must already stand. The batch level is read from OMCE. A plant is part of the identity only at plant level. The screen reads the same row MSC1N creates. The restricted-use indicator is X or blank, and only when it was stored. It is not 1 or 2. The date of manufacture is HSDAT, not HERDT. The vendor batch is separate from the batch number. Deletion, classification, MB5C, and inspection lots are not stored. Stock has no batch, so this screen does not show stock as batch stock. Display writes nothing.$msc3n$,
  'TIER_1_BUILT',
  '/inventory/batches/display',
  'B',
  'MIGRATION_9114'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9114',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MSC3N', 'SEARCH_ONLY', 'MIGRATION_9114'
FROM term_registry t
WHERE t.our_code = 'INV.BATCH.DISPLAY'
ON CONFLICT (external_system, alias) DO NOTHING;
