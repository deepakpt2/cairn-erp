-- CU70 stores a sort sequence. It is not a class and not a strategy record.
-- No standard sequence is seeded. The sequence does not select a batch.

CREATE TABLE IF NOT EXISTS batch_sort_sequence (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  sort_sequence varchar(18) NOT NULL,
  description varchar(40) NOT NULL,
  status char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, sort_sequence),
  CONSTRAINT batch_sort_sequence_name_ck CHECK (sort_sequence ~ '^[A-Z0-9_]{1,18}$'),
  CONSTRAINT batch_sort_sequence_status_ck CHECK (status in ('0', '1', '2')),
  CONSTRAINT batch_sort_sequence_version_ck CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS batch_sort_sequence_criterion (
  client varchar(4) NOT NULL,
  sort_sequence varchar(18) NOT NULL,
  position integer NOT NULL,
  characteristic_name varchar(30) NOT NULL,
  direction char(1) NOT NULL,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, sort_sequence, position),
  CONSTRAINT batch_sort_sequence_criterion_fk
    FOREIGN KEY (client, sort_sequence)
    REFERENCES batch_sort_sequence (client, sort_sequence)
    ON DELETE CASCADE,
  CONSTRAINT batch_sort_sequence_criterion_position_ck CHECK (position > 0),
  CONSTRAINT batch_sort_sequence_criterion_direction_ck CHECK (direction in ('A', 'D')),
  CONSTRAINT batch_sort_sequence_criterion_name_ck CHECK (characteristic_name ~ '^[A-Z0-9_]{1,30}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS batch_sort_sequence_criterion_uk
  ON batch_sort_sequence_criterion (client, sort_sequence, characteristic_name);

ALTER TABLE batch_sort_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_sort_sequence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_sort_sequence
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_sort_sequence FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_sort_sequence TO cairn_app;

ALTER TABLE batch_sort_sequence_criterion ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_sort_sequence_criterion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_sort_sequence_criterion
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_sort_sequence_criterion FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_sort_sequence_criterion TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCHSORT.MAINTAIN',
  'INV',
  'MAINTAIN',
  false,
  'Create, change and display a batch sort sequence. CU70, CU71, and CU72 are search aliases only. The sequence does not select a batch.'
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
  'INV.BATCHSORT.MAINTAIN',
  NULL,
  'Batch sort sequence',
  'TRANSACTION',
  'INV',
  $cu70$Batch sort sequence. CU70 creates it, CU71 changes it, and CU72 displays it. The name is at most 18 characters. The description is at most 40 characters, in one language. Status is 0 in preparation, 1 released, or 2 locked. Each criterion names a standing characteristic, or the stock exceptions LOBM_LGORT and LOBM_MENGE, and sorts ascending or descending. Those two must not stand in a batch class. A weighting factor is not stored. The sequence is not assigned to a search strategy. It does not select a batch, read a characteristic value, or post. Production, sales, and warehouse determination are not this screen. Opening this screen writes nothing.$cu70$,
  'TIER_1_BUILT',
  '/inventory/batch-sort-sequences',
  'B',
  'MIGRATION_9142'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9142',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', alias.code, 'SEARCH_ONLY', 'MIGRATION_9142'
FROM term_registry t
CROSS JOIN (VALUES ('CU70'), ('CU71'), ('CU72')) AS alias(code)
WHERE t.our_code = 'INV.BATCHSORT.MAINTAIN'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCHSORT.MAINTAIN', 'MIGRATION_9142'
FROM role_capability rc
WHERE rc.capability_code IN (
  'INV.BATCHCLASS.MAINTAIN',
  'INV.BATCHSTRATEGY.MAINTAIN',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;
