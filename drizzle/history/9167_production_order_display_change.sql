-- CO03 / CO02. A version lets a stale change conflict.
-- Existing orders start at 1. No operation, sequence, order type, or status is added.
-- Created and released remain the only statuses.

ALTER TABLE production_order
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE production_order
  ADD CONSTRAINT production_order_version_ck CHECK (version > 0);

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  (
    'PROD.ORDER.DISPLAY',
    'PROD',
    'DISPLAY',
    false,
    'Display a production order. CO03 is a search alias. Display writes nothing, takes no change lock, and does not release, change, or post.'
  ),
  (
    'PROD.ORDER.CHANGE',
    'PROD',
    'CHANGE',
    false,
    'Change a production order. CO02 is a search alias. Quantity, dates, and components can change only while no goods movement cites the order. Change does not release, reschedule, or post.'
  )
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, granted.capability_code, 'MIGRATION_9167'
FROM role_capability rc
CROSS JOIN (
  VALUES ('PROD.ORDER.DISPLAY'), ('PROD.ORDER.CHANGE')
) AS granted(capability_code)
WHERE rc.capability_code = 'PROD.ORDER.CREATE'
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES
  (
    gen_random_uuid()::text,
    'PROD.ORDER.DISPLAY',
    NULL,
    'Display production order',
    'TRANSACTION',
    'PROD',
    'Display a production order. CO03 is a search alias. The number is the key. Quantity, unit, dates, status, components, and a stored planned-order link are shown as stored. Issued and received quantities are read from material documents. An order type, a controlling area, a scrap portion, a production version, operations, and sequences are not stored. Display writes nothing and takes no change lock.',
    'TIER_1_BUILT',
    '/production/production-order-display',
    'B',
    'MIGRATION_9167'
  ),
  (
    gen_random_uuid()::text,
    'PROD.ORDER.CHANGE',
    NULL,
    'Change production order',
    'TRANSACTION',
    'PROD',
    'Change a production order. CO02 is a search alias. The number, material, plant, unit, and status stay fixed. Quantity, dates, and component quantities can change while no goods movement cites the order. A header quantity change does not rescale components. Operations are not stored, so nothing is rescheduled. Change does not release the order and posts nothing.',
    'TIER_1_BUILT',
    '/production/production-order-change',
    'B',
    'MIGRATION_9167'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9167',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', alias.alias, 'SEARCH_ONLY', 'MIGRATION_9167'
FROM (
  VALUES ('PROD.ORDER.DISPLAY', 'CO03'), ('PROD.ORDER.CHANGE', 'CO02')
) AS alias(our_code, alias)
JOIN term_registry t ON t.our_code = alias.our_code
ON CONFLICT (external_system, alias) DO NOTHING;
