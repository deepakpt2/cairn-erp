-- OPJK / TCO11. Checking control for a production order type in a plant.
-- The SAP key is client, plant, order type, and business function.
-- Function 1 is check availability during order creation.
-- Function 2 is check availability during order release.
-- The plant key follows the standing plant master. It is not shortened.
-- The order type must be a standing production order type of category 10.
-- A checking rule is optional. When named, it must already stand.
-- The no-check and check-on-save indicators have no default. An omitted
-- value is rejected. A missing row is not a check and not a no-check.
-- varchar is used instead of CHAR so an empty indicator is not padded to blank.
-- Release, PRT, capacity, creation control, and a component-check type are
-- not stored. Saving does not run a check. No row is seeded.

CREATE TABLE production_checking_control (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  order_type varchar(4) NOT NULL,
  business_function varchar(1) NOT NULL,
  no_check varchar(1) NOT NULL,
  checking_rule varchar(2),
  check_on_save varchar(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, plant, order_type, business_function),
  CONSTRAINT production_checking_control_plant_fk
    FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT production_checking_control_type_fk
    FOREIGN KEY (client, order_type) REFERENCES production_order_type (client, order_type) ON DELETE RESTRICT,
  CONSTRAINT production_checking_control_rule_fk
    FOREIGN KEY (client, checking_rule) REFERENCES availability_checking_rule (client, checking_rule) ON DELETE RESTRICT,
  CONSTRAINT production_checking_control_function_ck CHECK (business_function IN ('1', '2')),
  CONSTRAINT production_checking_control_no_check_ck CHECK (no_check IN ('X', ' ')),
  CONSTRAINT production_checking_control_save_ck CHECK (check_on_save IN ('X', ' ')),
  CONSTRAINT production_checking_control_rule_ck CHECK (checking_rule IS NULL OR checking_rule ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT production_checking_control_type_ck CHECK (order_type ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_checking_control_plant_ck CHECK (char_length(plant) BETWEEN 1 AND 10),
  CONSTRAINT production_checking_control_version_ck CHECK (version > 0)
);

ALTER TABLE production_checking_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_checking_control FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_checking_control
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_checking_control FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_checking_control TO cairn_app;

COMMENT ON TABLE production_checking_control IS
  'OPJK checking control. Key is plant, order type, and business function. A missing row is unconfigured. No check runs.';
COMMENT ON COLUMN production_checking_control.business_function IS
  'TCO11-VORGANG / CO_VFVG. 1 is creation. 2 is release. No other value is stored.';
COMMENT ON COLUMN production_checking_control.no_check IS
  'TCO11-PRUEFKZ. X means no automatic material availability check. Blank means the indicator is not set. Neither value runs a check.';
COMMENT ON COLUMN production_checking_control.check_on_save IS
  'TCO11-ATPSAVEKZ. X means the check-on-save indicator is set. Blank means it is not set. Neither value runs a check.';
COMMENT ON COLUMN production_checking_control.checking_rule IS
  'TCO11-PRREG. Optional. A named rule must stand. Null is not a default rule and is not a no-check.';

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROD.CHECKCTRL.DEFINE',
  'PROD',
  'CONFIGURE',
  false,
  'Define checking control for a production order type in a plant. No check runs.'
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
  'CFG.PROD.CHECKCTRL.DEFINE',
  'PRODUCTION',
  NULL,
  'Define checking control',
  'DEFINE',
  'CFG.ORG.PLANT.DEFINE,CFG.PROD.ORDERTYPE.DEFINE,CFG.PROD.AVCHECK.DEFINE',
  'A checking-control record for a plant, production order type, and business function, without running a check',
  970,
  'STANDARD',
  '/config/checking-control',
  true,
  'MIGRATION_9180'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9180',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.CHECKCTRL.DEFINE', 'NOT_STARTED', 'MIGRATION_9180'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.PROD.CHECKCTRL.DEFINE', 'MIGRATION_9180'
FROM role_capability rc
WHERE rc.capability_code IN ('CFG.ORG.PLANT.DEFINE', 'CFG.PLT.CLIENT.ONBOARD')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROD.CHECKCTRL.DEFINE',
  NULL,
  'Checking control',
  'CONFIG_ACTIVITY',
  'PROD',
  $opjk$Checking control. OPJK is a search alias. The key is a standing plant, a standing production order type, and business function 1 or 2. Function 1 is check availability during order creation. Function 2 is check availability during order release. A missing record is not a check and not a no-check. The no-check indicator must be chosen. X means no automatic material availability check. Blank means the indicator is not set. Check on save must be chosen. X means that indicator is set. Blank means it is not set. Neither value runs a check. A checking rule is optional and must already stand. Blank is not a default rule. The category is production order only. Release, creation control, PRT, capacity, and a component-check type are not stored. CO01, release, conversion, and MRP do not read it. CO09 remains blocked. ATP is not calculated.$opjk$,
  'TIER_2_CONFIGURED',
  '/config/checking-control',
  'B',
  'MIGRATION_9180'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9180',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OPJK', 'SEARCH_ONLY', 'MIGRATION_9180'
FROM term_registry t
WHERE t.our_code = 'CFG.PROD.CHECKCTRL.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
