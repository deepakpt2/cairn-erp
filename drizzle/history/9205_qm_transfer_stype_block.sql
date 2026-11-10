-- QM slice 2: add QUALITY -> BLOCKED stock type transfer for usage decisions.
--
-- Usage decisions that reject or block inspected goods move stock from QUALITY
-- to BLOCKED. This movement type gives that transfer its own catalogue entry
-- so the transfer-posting engine can post it with a material document and
-- ledger trace, instead of writing stock_quantity directly.
INSERT INTO movement_type (client, movement_type, description, direction, reference_category,
  movement_kind, source_stock_type, destination_stock_type, plant_rule, location_rule,
  valuation_relevant, account_assignment, created_by)
SELECT c.client, 'TRANSFER_STYPE_BLOCK', 'Quality inspection to blocked stock', 'TRANSFER',
  'MATERIAL_DOCUMENT', 'STOCK_TYPE', 'QUALITY', 'BLOCKED', 'SAME', 'SAME',
  false, 'NONE', 'SYSTEM'
FROM client c
ON CONFLICT (client, movement_type) DO NOTHING;
