-- OMCG allocates an Inventory Management search procedure to a movement type.
-- The key is the movement type and the special stock. Blank is own stock.
-- A plant is not part of the key. The check indicator is stored and does not
-- select a batch. No standard allocation is seeded.

CREATE TABLE IF NOT EXISTS batch_search_allocation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  movement_type varchar(20) NOT NULL,
  special_stock char(1) NOT NULL DEFAULT ' ',
  usage char(1) NOT NULL DEFAULT 'H',
  application char(2) NOT NULL DEFAULT 'ME',
  search_procedure varchar(6) NOT NULL,
  transfer_procedure varchar(6) NOT NULL DEFAULT '',
  check_batch char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, movement_type, special_stock),
  CONSTRAINT batch_search_allocation_movement_fk
    FOREIGN KEY (client, movement_type)
    REFERENCES movement_type (client, movement_type)
    ON DELETE CASCADE,
  CONSTRAINT batch_search_allocation_procedure_fk
    FOREIGN KEY (client, usage, application, search_procedure)
    REFERENCES batch_search_procedure (client, usage, application, search_procedure)
    ON DELETE CASCADE,
  CONSTRAINT batch_search_allocation_stock_ck CHECK (special_stock = ' '),
  CONSTRAINT batch_search_allocation_usage_ck CHECK (usage = 'H'),
  CONSTRAINT batch_search_allocation_application_ck CHECK (application = 'ME'),
  CONSTRAINT batch_search_allocation_procedure_ck CHECK (search_procedure ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT batch_search_allocation_transfer_ck CHECK (transfer_procedure = '' OR transfer_procedure ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT batch_search_allocation_check_ck CHECK (check_batch IN (' ', 'X')),
  CONSTRAINT batch_search_allocation_version_ck CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS batch_search_allocation_procedure_idx
  ON batch_search_allocation (client, usage, application, search_procedure);
CREATE INDEX IF NOT EXISTS batch_search_allocation_transfer_idx
  ON batch_search_allocation (client, usage, application, transfer_procedure);

ALTER TABLE batch_search_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_search_allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_search_allocation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_search_allocation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_search_allocation TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHALLOCATE.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Allocate an Inventory Management search procedure. OMCG is a search alias only. The key is the movement type and own stock. The procedure must already stand. The check indicator does not select a batch.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.INV.BATCHALLOCATE.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Allocate IM search procedure',
  'DEFINE',
  'CFG.INV.BATCHSEARCH.DEFINE',
  'A movement-type allocation, without selecting a batch',
  964,
  'STANDARD',
  '/config/batch-search-allocations',
  true,
  'MIGRATION_9139'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9139',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHALLOCATE.DEFINE', 'NOT_STARTED', 'MIGRATION_9139'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHALLOCATE.DEFINE', 'MIGRATION_9139'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHSEARCH.DEFINE',
  'CFG.INV.MOVETYPE.CONFIG',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHALLOCATE.DEFINE',
  NULL,
  'Allocate IM search procedure',
  'CONFIG_ACTIVITY',
  'INV',
  $omcg$Allocate an Inventory Management search procedure. OMCG is a search alias only. The key is the movement type and the special stock. Blank special stock is own stock, not a plant and not a wildcard. Special-stock indicators do not stand, so only own stock can be allocated. The procedure must already stand on OMCY for usage H and application ME. A transfer-side procedure is optional and must also stand. The check indicator is X or blank. X records the request and does not check a batch, because selection criteria do not stand. A plant, a transport, and a production or sales allocation are refused. Opening this screen writes nothing.$omcg$,
  'TIER_2_CONFIGURED',
  '/config/batch-search-allocations',
  'B',
  'MIGRATION_9139'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9139',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCG', 'SEARCH_ONLY', 'MIGRATION_9139'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHALLOCATE.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
