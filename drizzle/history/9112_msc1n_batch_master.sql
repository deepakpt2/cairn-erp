-- MSC1N extends the existing batch identity. It does not add a second
-- batch master, a company code, or stock. ZUSTD is the restricted-use
-- indicator: X restricted, blank unrestricted, null when status
-- management does not apply. Internal numbering is not activated here.

ALTER TABLE material
  ADD COLUMN batch_managed boolean NOT NULL DEFAULT false;

ALTER TABLE material_plant
  ADD COLUMN batch_managed boolean NOT NULL DEFAULT false;

ALTER TABLE material_type
  ADD COLUMN initial_batch_restricted boolean NOT NULL DEFAULT false;

ALTER TABLE batch
  ADD COLUMN restricted_use char(1),
  ADD COLUMN manufacture_date date,
  ADD COLUMN shelf_life_expiration_date date,
  ADD COLUMN vendor_batch varchar(15),
  ADD COLUMN country_of_origin char(2),
  ADD COLUMN request_key varchar(64);

ALTER TABLE batch
  ADD CONSTRAINT batch_restricted_use_ck CHECK (restricted_use IS NULL OR restricted_use IN ('X', ' ')),
  ADD CONSTRAINT batch_vendor_batch_ck CHECK (vendor_batch IS NULL OR char_length(vendor_batch) BETWEEN 1 AND 15),
  ADD CONSTRAINT batch_country_fk FOREIGN KEY (country_of_origin) REFERENCES country (code);

CREATE UNIQUE INDEX batch_request_key_uq
  ON batch (client, request_key)
  WHERE request_key IS NOT NULL;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCH.CREATE',
  'INV',
  'CREATE',
  false,
  'Create a batch master. MSC1N is a search alias only. Creating a batch does not post stock.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCH.CREATE', 'MIGRATION_9112'
FROM role_capability rc
WHERE rc.capability_code IN ('INV.MATERIAL.MAINTAIN', 'INV.GR.POST', 'CFG.INV.BATCHLEVEL.DEFINE')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'INV.BATCH.CREATE',
  'batch',
  'Create batch',
  'TRANSACTION',
  'INV',
  $msc1n$Create a batch master. MSC1N is a search alias only. The material must exist and be batch-managed. The batch level is read from OMCE. A plant is part of the identity only at plant level. The batch number is entered; internal assignment is not active because OMCZ and OMAD are not this screen. The status indicator is X for restricted and blank for unrestricted, and only when OMCS is effective. It is not stored as 1 or 2. A batch does not create stock. MSC2N and MSC3N are not this screen.$msc1n$,
  'TIER_1_BUILT',
  '/inventory/batches/new',
  'B',
  'MIGRATION_9112'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9112',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MSC1N', 'SEARCH_ONLY', 'MIGRATION_9112'
FROM term_registry t
WHERE t.our_code = 'INV.BATCH.CREATE'
ON CONFLICT (external_system, alias) DO NOTHING;
