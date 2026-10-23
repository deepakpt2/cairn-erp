-- MBC1 stores an Inventory Management batch search strategy.
-- The key combination is a standing condition table. Validity is the
-- business period. A selection class and a sort rule are not stored.
-- No standard strategy is seeded, and no batch is selected.

CREATE TABLE IF NOT EXISTS batch_search_strategy (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  record_number char(10) NOT NULL,
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  strategy_type varchar(4) NOT NULL,
  condition_table char(3) NOT NULL,
  key_fingerprint varchar(500) NOT NULL,
  valid_from varchar(10) NOT NULL,
  valid_to varchar(10) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, record_number),
  CONSTRAINT batch_search_strategy_type_fk
    FOREIGN KEY (client, usage, application, strategy_type)
    REFERENCES batch_strategy_type (client, usage, application, strategy_type)
    ON DELETE CASCADE,
  CONSTRAINT batch_search_strategy_table_fk
    FOREIGN KEY (client, usage, condition_table)
    REFERENCES batch_condition_table (client, usage, condition_table)
    ON DELETE CASCADE,
  CONSTRAINT batch_search_strategy_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_search_strategy_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_search_strategy_record_ck CHECK (record_number ~ '^[0-9]{10}$'),
  CONSTRAINT batch_search_strategy_from_ck CHECK (valid_from ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT batch_search_strategy_to_ck CHECK (valid_to ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT batch_search_strategy_period_ck CHECK (valid_from <= valid_to),
  CONSTRAINT batch_search_strategy_version_ck CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS batch_search_strategy_key_uk
  ON batch_search_strategy (client, usage, application, strategy_type, condition_table, key_fingerprint, valid_to);
CREATE INDEX IF NOT EXISTS batch_search_strategy_lookup_idx
  ON batch_search_strategy (client, strategy_type, condition_table, key_fingerprint);

CREATE TABLE IF NOT EXISTS batch_search_strategy_key (
  client varchar(4) NOT NULL,
  record_number char(10) NOT NULL,
  field_name varchar(30) NOT NULL,
  field_value varchar(40) NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (client, record_number, field_name),
  CONSTRAINT batch_search_strategy_key_fk
    FOREIGN KEY (client, record_number)
    REFERENCES batch_search_strategy (client, record_number)
    ON DELETE CASCADE,
  CONSTRAINT batch_search_strategy_key_position_ck CHECK (position BETWEEN 1 AND 9),
  CONSTRAINT batch_search_strategy_key_value_ck CHECK (length(btrim(field_value)) >= 1)
);

ALTER TABLE batch_search_strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_search_strategy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_search_strategy
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_search_strategy FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_search_strategy TO cairn_app;

ALTER TABLE batch_search_strategy_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_search_strategy_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_search_strategy_key
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_search_strategy_key FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_search_strategy_key TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'INV.BATCHSTRATEGY.MAINTAIN',
  'INV',
  'MAINTAIN',
  false,
  'Maintain an Inventory Management batch search strategy. MBC1, MBC2, and MBC3 are search aliases only. The key combination comes from the strategy type. The record does not select a batch.'
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
  'INV.BATCHSTRATEGY.MAINTAIN',
  NULL,
  'Batch search strategy',
  'TRANSACTION',
  'INV',
  $mbc1$Inventory Management batch search strategy. MBC1 creates it, MBC2 changes the validity period, and MBC3 displays it. Usage is H and application is ME. The strategy type must already stand on OMCW and name an access sequence. The key combination is a condition table named by that sequence. The key fields are that table's fields, not a hard-coded plant or material. Validity from must not be later than validity to, and the same key must not overlap. A selection class, a sort rule, and a quantity proposal are not stored. Class type 023 is not active. Saving does not select a batch or post stock. Production and sales strategies are not this screen. Opening this screen writes nothing.$mbc1$,
  'TIER_1_BUILT',
  '/inventory/batch-search-strategies',
  'B',
  'MIGRATION_9140'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9140',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', alias.code, 'SEARCH_ONLY', 'MIGRATION_9140'
FROM term_registry t
CROSS JOIN (VALUES ('MBC1'), ('MBC2'), ('MBC3')) AS alias(code)
WHERE t.our_code = 'INV.BATCHSTRATEGY.MAINTAIN'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'INV.BATCHSTRATEGY.MAINTAIN', 'MIGRATION_9140'
FROM role_capability rc
WHERE rc.capability_code IN (
  'INV.BATCH.CREATE',
  'CFG.INV.BATCHSEARCH.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;
