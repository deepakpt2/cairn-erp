-- MB5C is the pick-up list for batches that already stand on a material
-- document. It adds no table and no index. Sales documents are not stored
-- on the material document, so they are not selected here.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCH.PICKUP',
  'INV',
  'DISPLAY',
  false,
  'Pick-up list for batches that already stand on a material document. MB5C is a search alias only. The list does not create a batch and does not post.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCH.PICKUP', 'MIGRATION_9119'
FROM role_capability rc
WHERE rc.capability_code IN ('INV.BATCH.DISPLAY', 'INV.STOCK.WAREHOUSE', 'INV.STOCK.VIEW', 'INV.MATERIALDOC.LIST')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

UPDATE term_registry
   SET description = $msc3n$Display a batch master. MSC3N is a search alias only. The batch must already stand. The batch level is read from OMCE. A plant is part of the identity only at plant level. The screen reads the same row MSC1N creates. The restricted-use indicator is X or blank, and only when it was stored. It is not 1 or 2. The date of manufacture is HSDAT, not HERDT. The vendor batch is separate from the batch number. Deletion, classification, and inspection lots are not stored. This screen does not show stock. The pick-up list is MB5C. Display writes nothing.$msc3n$,
       changed_by = 'MIGRATION_9119',
       changed_at = now()
 WHERE our_code = 'INV.BATCH.DISPLAY';

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'INV.BATCH.PICKUP',
  NULL,
  'Pick-up list for batch where-used',
  'TRANSACTION',
  'INV',
  $mb5c$Pick-up list for batches that already stand and already appear on a material document. MB5C is a search alias only. Naming a batch lists those document lines. A batch that has never been posted is not listed. A blank batch is not listed. The list does not create a batch and does not post. A sales order, a delivery, a billing document, and a scheduling agreement are refused by name, because those documents are not on the material document.$mb5c$,
  'TIER_1_BUILT',
  '/inventory/batch-pickup',
  'B',
  'MIGRATION_9119'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9119',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MB5C', 'SEARCH_ONLY', 'MIGRATION_9119'
FROM term_registry t
WHERE t.our_code = 'INV.BATCH.PICKUP'
ON CONFLICT (external_system, alias) DO NOTHING;
