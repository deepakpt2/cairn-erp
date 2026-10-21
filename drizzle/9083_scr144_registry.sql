-- SCR-144: the two capabilities this round adds, and their registry terms.
--
-- CUNI and MB5L are reference identifiers offered as a lookup courtesy (§19.5 AI-05); neither is
-- one of our codes. Our codes are INV.STOCK.UOM and INV.STOCK.RECONCILE.

INSERT INTO capability (code, module, description, action, is_posting_relevant)
VALUES
  ('INV.STOCK.UOM', 'INV',
   'Maintain, per material, the alternative units it accepts and the exact ratio to its base unit',
   'DEFINE', false),
  ('INV.STOCK.RECONCILE', 'INV',
   'Compare the stock projection with the material document ledger and rebuild a drifted dimension',
   'DISPLAY', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier,
   route_path, conformance_tier, created_by)
VALUES
  (gen_random_uuid()::text, 'INV.STOCK.UOM', 'material_uom_conversion',
   'Units of measure per material', 'TRANSACTION', 'INV',
   'Maintain the alternative units a material accepts. Each row states one alternative unit with an integer numerator and denominator against the base unit, so a posting entered in that unit converts by exact rational arithmetic, rounded to the base unit''s decimal places, and the ledger records the base quantity. Entry quantity and entry unit are stored as entered. A unit with no row is refused by name, naming the conversion that is missing and the capability that maintains it; a conversion from the base unit to itself is refused, and a unit the catalogue does not know is refused.',
   'TIER_1_BUILT', '/inventory/uom-conversion', 'B', 'SCR144_MIGRATION'),
  (gen_random_uuid()::text, 'INV.STOCK.RECONCILE', NULL,
   'Stock reconciliation', 'TRANSACTION', 'INV',
   'Compare the stock projection with the material document ledger. The ledger is the material documents themselves: every line names its document and its direction gives the sign, so the sum per material, plant, storage location and stock type is the balance the documents justify. Only dimensions that disagree are listed, with ledger quantity, projected quantity and the difference; a projection row with no documents behind it is drift of its full quantity. A drifted dimension can be rebuilt from the ledger, which posts and values nothing and deletes a dimension the ledger no longer knows; the rebuild refuses while a physical inventory count holds the dimension open, because that count is about to compare against the same number.',
   'TIER_1_BUILT', '/inventory/stock-reconcile', 'B', 'SCR144_MIGRATION')
ON CONFLICT (our_code) DO NOTHING;

INSERT INTO term_alias (id, external_system, alias, term_id, created_by)
SELECT gen_random_uuid()::text, 'REFERENCE_ERP', v.alias, t.id, 'SCR144_MIGRATION'
FROM (VALUES
  ('CUNI', 'INV.STOCK.UOM'),
  ('MB5L', 'INV.STOCK.RECONCILE')
) AS v(alias, our_code)
JOIN term_registry t ON t.our_code = v.our_code
ON CONFLICT (external_system, alias) DO NOTHING;
