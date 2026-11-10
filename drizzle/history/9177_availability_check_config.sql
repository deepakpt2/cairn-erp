-- Availability-check configuration only. This is not CO09 and it does not calculate ATP.
--
-- SAP relationships kept:
--   TMVF checking group is client customizing. MARC-MTVFP assigns it on the material plant view.
--   T441R checking rule is a separate key. It is not a checking group and not a material field.
--   T441V scope of check is the pair of one group and one rule.
--
-- Deviations, because the missing source would make a stored flag look operational:
--   No language text table. The group description is BEZEI20 on the row. The rule description is PRRLT.
--   TMVF does not store sales or delivery accumulation, a replenishment lead time, a material block,
--   an online/background mode, a shortfall response, planning relevance, or advanced ATP.
--   T441V does not store stock in transfer, dependent reservations, sales requirements, deliveries,
--   shipping notifications, check-without-RLT, missing-parts days, stock-transport releases,
--   subcontracting, storage-location inspection, independent requirements, or an unrestricted-stock switch.
--   BESTP value A, PLAFP value B, and RPAST values A and C are rejected by the check constraints.
--   No checking control (OPJK) is stored, so no order type is bound to a rule.
--   A missing material assignment stays null. It is not defaulted to a group.

CREATE TABLE availability_checking_group (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  checking_group varchar(2) NOT NULL,
  description varchar(20) NOT NULL,
  no_check char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, checking_group),
  CONSTRAINT availability_checking_group_key_ck CHECK (checking_group ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT availability_checking_group_text_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 20),
  CONSTRAINT availability_checking_group_no_check_ck CHECK (no_check IN ('X', ' ')),
  CONSTRAINT availability_checking_group_version_ck CHECK (version > 0)
);

CREATE TABLE availability_checking_rule (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  checking_rule varchar(2) NOT NULL,
  description varchar(40) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, checking_rule),
  CONSTRAINT availability_checking_rule_key_ck CHECK (checking_rule ~ '^[A-Z0-9]{2}$'),
  CONSTRAINT availability_checking_rule_text_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT availability_checking_rule_version_ck CHECK (version > 0)
);

CREATE TABLE availability_check_scope (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  checking_group varchar(2) NOT NULL,
  checking_rule varchar(2) NOT NULL,
  include_safety_stock char(1) NOT NULL,
  include_quality_stock char(1) NOT NULL,
  include_blocked_stock char(1) NOT NULL,
  include_restricted_use char(1) NOT NULL,
  purchase_orders char(1) NOT NULL,
  purchase_requisitions char(1) NOT NULL,
  planned_orders char(1) NOT NULL,
  production_orders char(1) NOT NULL,
  dependent_requirements char(1) NOT NULL,
  reservations char(1) NOT NULL,
  receipts_in_past char(1) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, checking_group, checking_rule),
  CONSTRAINT availability_check_scope_group_fk
    FOREIGN KEY (client, checking_group)
    REFERENCES availability_checking_group (client, checking_group) ON DELETE RESTRICT,
  CONSTRAINT availability_check_scope_rule_fk
    FOREIGN KEY (client, checking_rule)
    REFERENCES availability_checking_rule (client, checking_rule) ON DELETE RESTRICT,
  CONSTRAINT availability_check_scope_xfeld_ck CHECK (
    include_safety_stock IN ('X', ' ')
    AND include_quality_stock IN ('X', ' ')
    AND include_blocked_stock IN ('X', ' ')
    AND include_restricted_use IN ('X', ' ')
    AND purchase_orders IN ('X', ' ')
    AND purchase_requisitions IN ('X', ' ')
    AND dependent_requirements IN ('X', ' ')
    AND reservations IN ('X', ' ')
  ),
  CONSTRAINT availability_check_scope_planned_ck CHECK (planned_orders IN ('X', 'A', ' ')),
  CONSTRAINT availability_check_scope_production_ck CHECK (production_orders IN ('X', 'F', ' ')),
  CONSTRAINT availability_check_scope_past_ck CHECK (receipts_in_past IN ('B', ' ')),
  CONSTRAINT availability_check_scope_version_ck CHECK (version > 0)
);

ALTER TABLE availability_checking_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_checking_group FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON availability_checking_group
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON availability_checking_group FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON availability_checking_group TO cairn_app;

ALTER TABLE availability_checking_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_checking_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON availability_checking_rule
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON availability_checking_rule FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON availability_checking_rule TO cairn_app;

ALTER TABLE availability_check_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_check_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON availability_check_scope
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON availability_check_scope FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON availability_check_scope TO cairn_app;

ALTER TABLE material_plant
  ADD COLUMN checking_group varchar(2);

ALTER TABLE material_plant
  ADD CONSTRAINT material_plant_checking_group_fk
  FOREIGN KEY (client, checking_group)
  REFERENCES availability_checking_group (client, checking_group) ON DELETE RESTRICT;

CREATE INDEX material_plant_checking_group_idx
  ON material_plant (client, checking_group)
  WHERE checking_group IS NOT NULL;

COMMENT ON COLUMN material_plant.checking_group IS
  'MARC-MTVFP. Null means no checking group is assigned. It is not inferred and it is not a checking rule.';

COMMENT ON COLUMN availability_check_scope.production_orders IS
  'FERTP blank, X, or F. This column does not say that a technically completed order is an open receipt.';

COMMENT ON COLUMN availability_check_scope.dependent_requirements IS
  'SKBDP. Planned-order dependent requirements only. Production-order components are not this flag.';

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROD.AVCHECK.DEFINE',
  'PROD',
  'CONFIGURE',
  false,
  'Define availability-check configuration. A checking group, a checking rule, and a scope of check are stored. No ATP quantity is calculated.'
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
  'CFG.PROD.AVCHECK.DEFINE',
  'PRODUCTION',
  NULL,
  'Define availability check',
  'DEFINE',
  'CFG.ORG.PLANT.DEFINE',
  'Checking groups, checking rules, and scopes of check, without an ATP calculation',
  967,
  'STANDARD',
  '/config/availability-check',
  true,
  'MIGRATION_9177'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9177',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.AVCHECK.DEFINE', 'NOT_STARTED', 'MIGRATION_9177'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.PROD.AVCHECK.DEFINE', 'MIGRATION_9177'
FROM role_capability rc
WHERE rc.capability_code IN ('CFG.ORG.PLANT.DEFINE', 'CFG.PLT.CLIENT.ONBOARD')
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROD.AVCHECK.DEFINE',
  NULL,
  'Availability check configuration',
  'CONFIG_ACTIVITY',
  'PROD',
  $avcheck$Availability-check configuration. OVZ2, OPJL, OVZ9, and OPJJ are search aliases only. A checking group is client customizing, assigned on the material plant view, and is not a checking rule. A missing assignment is not a default group. A checking rule names a business context and is not bound to order creation, conversion, MRP, or sales. A scope of check is the pair of one standing group and one standing rule. It stores inclusion controls only for sources this system can name. It does not calculate ATP, does not read MD04, and does not post. Replenishment lead time, sales orders, deliveries, stock in transfer, dependent reservations, and storage-location inspection are refused.$avcheck$,
  'TIER_2_CONFIGURED',
  '/config/availability-check',
  'B',
  'MIGRATION_9177'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9177',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9177'
FROM term_registry t
CROSS JOIN (VALUES ('OVZ2'), ('OPJL'), ('OVZ9'), ('OPJJ')) AS v(alias)
WHERE t.our_code = 'CFG.PROD.AVCHECK.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
