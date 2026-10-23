-- MSC2N changes the existing batch row. It does not add a second master,
-- a stock column, or movements 341 and 342. Version is the optimistic
-- token. Existing rows start at 1.

ALTER TABLE batch
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE batch
  ADD CONSTRAINT batch_version_ck CHECK (version > 0);

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCH.CHANGE',
  'INV',
  'CHANGE',
  false,
  'Change a batch master. MSC2N is a search alias only. Changing a batch does not post stock and does not post movements 341 or 342.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCH.CHANGE', 'MIGRATION_9113'
FROM role_capability rc
WHERE rc.capability_code IN ('INV.BATCH.CREATE', 'INV.MATERIAL.MAINTAIN')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'INV.BATCH.CHANGE',
  NULL,
  'Change batch',
  'TRANSACTION',
  'INV',
  $msc2n$Change a batch master. MSC2N is a search alias only. The batch must already stand. The batch level is read from OMCE. A plant is part of the identity only at plant level. The material, plant, and batch number cannot be changed, and the number is not regenerated. Dates, the vendor batch, and the country of origin can be changed. The restricted-use indicator is X or blank, and only when OMCS is effective. It is not 1 or 2. Changing it does not post movements 341 or 342, because stock has no batch. A batch is not deleted here. MSC1N and MSC3N are not this screen.$msc2n$,
  'TIER_1_BUILT',
  '/inventory/batches/change',
  'B',
  'MIGRATION_9113'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9113',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MSC2N', 'SEARCH_ONLY', 'MIGRATION_9113'
FROM term_registry t
WHERE t.our_code = 'INV.BATCH.CHANGE'
ON CONFLICT (external_system, alias) DO NOTHING;
