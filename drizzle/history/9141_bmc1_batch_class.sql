-- BMC1 reuses classification_class. No batch class table is created.
-- The class type 022 or 023 is inserted by the save, from the batch level.
-- No standard class is seeded. A class is not assigned to a batch.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCHCLASS.MAINTAIN',
  'INV',
  'MAINTAIN',
  false,
  'Create, change and display a batch class. BMC1, BMC2, and BMC3 are search aliases only. The class type is 022 or 023 from the batch level. A class does not assign itself to a batch.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'INV.BATCHCLASS.MAINTAIN',
  NULL,
  'Batch class',
  'TRANSACTION',
  'INV',
  $bmc1$Batch class. BMC1 creates it, BMC2 changes its description and characteristic assignments, and BMC3 displays it. This is not CL01. The class is stored in the standing class tables. The class type is derived from the batch level: 022 at plant level, 023 at material or client level. It is not hard-coded, and it is not the house word BATCH. The class name is at most 18 characters. Characteristics must already stand and are not created here. A blocked characteristic is refused. One description is stored. A released or locked status is not invented. The class is not assigned to a material or a batch. Characteristic values are not stored. Saving does not select a batch or post stock. A goods movement is not changed. Opening this screen writes nothing.$bmc1$,
  'TIER_1_BUILT',
  '/inventory/batch-classes',
  'B',
  'MIGRATION_9141'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9141',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', alias.code, 'SEARCH_ONLY', 'MIGRATION_9141'
FROM term_registry t
CROSS JOIN (VALUES ('BMC1'), ('BMC2'), ('BMC3')) AS alias(code)
WHERE t.our_code = 'INV.BATCHCLASS.MAINTAIN'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCHCLASS.MAINTAIN', 'MIGRATION_9141'
FROM role_capability rc
WHERE rc.capability_code IN (
  'INV.BATCH.CREATE',
  'INV.BATCHSTRATEGY.MAINTAIN',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;
