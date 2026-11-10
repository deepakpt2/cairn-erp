-- MD11. Create a planned order by hand.
-- Origin may be MANUAL. Existing planning orders stay MRP.
-- No profile, MRP area, order type, or component table is added.

ALTER TABLE planned_order DROP CONSTRAINT IF EXISTS planned_order_origin_ck;
ALTER TABLE planned_order ADD CONSTRAINT planned_order_origin_ck CHECK (origin IN ('MRP', 'MANUAL'));

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.PLANNEDORDER.CREATE',
  'PROD',
  'CREATE',
  false,
  'Create a planned order by hand. MD11 is a search alias. The order is firmed and marked manual. Create does not explode a bill of material, does not convert the order, and posts nothing.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'PROD.PLANNEDORDER.CREATE', 'MIGRATION_9165'
FROM role_capability rc
WHERE rc.capability_code = 'PROD.MRP.RUN'
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.PLANNEDORDER.CREATE',
  NULL,
  'Create planned order',
  'TRANSACTION',
  'PROD',
  'Create a planned order by hand. MD11 is a search alias. The number is drawn from the planned-order range. The order is firmed and the origin is manual. A bought material is refused. A planned-order profile, an MRP area, an order type, a production version, a BOM, and a routing are not stored. Create does not explode a bill of material, does not convert the order, and posts nothing.',
  'TIER_1_BUILT',
  '/production/planned-order-create',
  'B',
  'MIGRATION_9165'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9165',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MD11', 'SEARCH_ONLY', 'MIGRATION_9165'
FROM term_registry t
WHERE t.our_code = 'PROD.PLANNEDORDER.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;
