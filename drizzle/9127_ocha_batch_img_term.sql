-- OCHA is IMG Batch Management, program RMIMGDIRECTOCHA.
-- It is not CT04. This migration adds the search term only.
-- It does not create a characteristic table and it does not reseed characteristics.

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHIMG.DISPLAY',
  NULL,
  'IMG Batch Management',
  'TRANSACTION',
  'INV',
  $ocha$IMG Batch Management. OCHA is a search alias only. It opens the batch management configuration index. It is not CT04. It does not define a characteristic, assign a class, or store a batch value. The index lists OMCE, OMCS, OMCU, OMCZ, and OMAD. It does not create a batch, post a movement, or select a plant. Class type 023 is not active. OMAB, batch determination, and movements 341 and 342 are not this screen. Opening this screen writes nothing.$ocha$,
  'TIER_1_BUILT',
  '/config/batch-management',
  'B',
  'MIGRATION_9127'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9127',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OCHA', 'SEARCH_ONLY', 'MIGRATION_9127'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHIMG.DISPLAY'
ON CONFLICT (external_system, alias) DO NOTHING;
