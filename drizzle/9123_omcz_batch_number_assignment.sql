-- OMCZ activates internal batch number assignment. The client flag is
-- TCUBN-AUTBN (historically TCUCH-AUTBN), domain CHAR1: X active, blank
-- not active. The plant flag is T159L-XCAUT, domain XFELD: X permits an
-- internal number on an account-assigned goods receipt. Neither flag
-- creates a BATCH_CLT interval, a batch, or a stock receipt.

CREATE TABLE batch_number_assignment (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  internal_assignment char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client),
  CONSTRAINT batch_number_assignment_code_ck CHECK (internal_assignment IN ('X', ' ')),
  CONSTRAINT batch_number_assignment_version_ck CHECK (version > 0)
);

CREATE TABLE batch_assigned_receipt (
  client varchar(4) NOT NULL,
  plant varchar(10) NOT NULL,
  assigned_receipt char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, plant),
  CONSTRAINT batch_assigned_receipt_plant_fk FOREIGN KEY (client, plant) REFERENCES plant (client, plant),
  CONSTRAINT batch_assigned_receipt_code_ck CHECK (assigned_receipt IN ('X', ' ')),
  CONSTRAINT batch_assigned_receipt_version_ck CHECK (version > 0)
);

ALTER TABLE batch_number_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_number_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_number_assignment
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_number_assignment FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_number_assignment TO cairn_app;

ALTER TABLE batch_assigned_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_assigned_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_assigned_receipt
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON batch_assigned_receipt FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_assigned_receipt TO cairn_app;

-- The object is registered so the existing number-range screen can hold
-- interval 01. No interval is created. Activating OMCZ does not number anything.
INSERT INTO number_range_object (
  client, object_code, description, number_length, year_relevant, subobject_hint, created_by, changed_by
)
SELECT c.client, 'BATCH_CLT', 'Internal batch numbers', 10, false, 'Interval 01', 'MIGRATION_9123', 'MIGRATION_9123'
FROM client c
ON CONFLICT (client, object_code) DO NOTHING;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.BATCHNUMBER.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Activate internal batch number assignment. OMCZ is a search alias only. The stored code is X or blank. It does not create a number range.'
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
  'CFG.INV.BATCHNUMBER.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Activate internal batch number assignment',
  'DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'Internal batch numbers when a later process asks for one',
  940,
  'STANDARD',
  '/config/batch-number-assignment',
  true,
  'MIGRATION_9123'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9123',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.INV.BATCHNUMBER.DEFINE', 'NOT_STARTED', 'MIGRATION_9123'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.INV.BATCHNUMBER.DEFINE', 'MIGRATION_9123'
FROM role_capability rc
WHERE rc.capability_code IN (
  'CFG.INV.BATCHSTATUS.DEFINE',
  'CFG.INV.BATCHLEVEL.DEFINE',
  'CFG.INV.MOVETYPE.CONFIG',
  'CFG.INV.VALCLASS.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.BATCHNUMBER.DEFINE',
  NULL,
  'Activate internal batch number assignment',
  'CONFIG_ACTIVITY',
  'INV',
  $omcz$Activate internal batch number assignment. OMCZ is a search alias only. The client flag is X when active and blank when not active. It is not a plant and not a material type. A separate plant flag permits an internal number only for an account-assigned goods receipt. That receipt is not posted here. The number range is BATCH_CLT interval 01, maintained on the number range screen. This screen does not create the interval, a batch, or a stock receipt. A closed posting period does not block it. A transport is refused by name.$omcz$,
  'TIER_2_CONFIGURED',
  '/config/batch-number-assignment',
  'B',
  'MIGRATION_9123'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9123',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMCZ', 'SEARCH_ONLY', 'MIGRATION_9123'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.BATCHNUMBER.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
