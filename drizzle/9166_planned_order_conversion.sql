-- CO40 / CO41. Link a production order to the planned order it converted.
-- Existing production orders stay unlinked. Multiple nulls remain valid.
-- The planned order row is not deleted and gains no status flag.

ALTER TABLE production_order
  ADD COLUMN planned_order_number varchar(12);

CREATE UNIQUE INDEX production_order_planned_uq
  ON production_order (client, planned_order_number);

ALTER TABLE production_order
  ADD CONSTRAINT production_order_planned_fk
  FOREIGN KEY (client, planned_order_number)
  REFERENCES planned_order (client, order_number);

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  (
    'PROD.PLANNEDORDER.CONVERT',
    'PROD',
    'CREATE',
    false,
    'Convert one planned order into a production order. CO40 is a search alias. The whole quantity is converted. The planned order is not deleted. External procurement is refused. Conversion posts no goods movement and no journal.'
  ),
  (
    'PROD.PLANNEDORDER.CONVERT.COLLECTIVE',
    'PROD',
    'CREATE',
    false,
    'Convert a selected set of planned orders. CO41 is a search alias. Each order is converted in its own transaction by the same service as CO40. Search writes nothing. Conversion posts no goods movement and no journal.'
  )
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, granted.capability_code, 'MIGRATION_9166'
FROM role_capability rc
CROSS JOIN (
  VALUES ('PROD.PLANNEDORDER.CONVERT'), ('PROD.PLANNEDORDER.CONVERT.COLLECTIVE')
) AS granted(capability_code)
WHERE rc.capability_code IN ('PROD.ORDER.CREATE', 'PROD.PLANNEDORDER.CREATE')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES
  (
    gen_random_uuid()::text,
    'PROD.PLANNEDORDER.CONVERT',
    NULL,
    'Convert planned order',
    'TRANSACTION',
    'PROD',
    'Convert one planned order into a production order. CO40 is a search alias. The production order is created by the existing order service. The production version is selected by the shared selector. Component quantities use the shared requirement function. The link is stored on the production order. The planned order is not deleted. A second conversion returns the existing order. External procurement and a partial quantity are refused. Operations, reservations, goods movements, journals, confirmations, costing, and settlement are not created. Availability is not checked. Release follows the scheduling profile already snapshotted at order creation.',
    'TIER_1_BUILT',
    '/production/planned-order-conversion',
    'B',
    'MIGRATION_9166'
  ),
  (
    gen_random_uuid()::text,
    'PROD.PLANNEDORDER.CONVERT.COLLECTIVE',
    NULL,
    'Collective conversion',
    'TRANSACTION',
    'PROD',
    'Convert a selected set of planned orders. CO41 is a search alias. Each order uses the same conversion service in its own transaction. One failure does not roll back another order. Search writes nothing. An MRP area, an opening date, a production version on the planned order, a sales order, a WBS element, a BOM explosion number, and availability are refused as filters because they are not stored.',
    'TIER_1_BUILT',
    '/production/planned-order-conversion-collective',
    'B',
    'MIGRATION_9166'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9166',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', alias.alias, 'SEARCH_ONLY', 'MIGRATION_9166'
FROM (
  VALUES ('PROD.PLANNEDORDER.CONVERT', 'CO40'), ('PROD.PLANNEDORDER.CONVERT.COLLECTIVE', 'CO41')
) AS alias(our_code, alias)
JOIN term_registry t ON t.our_code = alias.our_code
ON CONFLICT (external_system, alias) DO NOTHING;

UPDATE term_registry
SET description = 'Stock/requirements list, read-only and computed live. A planned order that has not been converted is a receipt. A created or released production order is a receipt for the open quantity. Sales orders and excess-stock alerts remain deferred. The list writes nothing.',
    changed_by = 'MIGRATION_9166',
    changed_at = now()
WHERE our_code = 'PROD.MRP.STOCKREQ';
