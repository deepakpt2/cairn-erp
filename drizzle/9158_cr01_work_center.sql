-- CR01 / CR02 / CR03. Work center master.
-- The key is the plant and a work center of at most 8 characters.
-- Category is tenant customizing. No 0001, usage 009, or formula SAP002 is seeded.
-- A formula key is stored. It is not calculated. No routing is created.

CREATE TABLE work_center_category (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  category varchar(4) NOT NULL,
  description varchar(40) NOT NULL,
  require_capacity boolean NOT NULL DEFAULT false,
  require_scheduling boolean NOT NULL DEFAULT false,
  require_costing boolean NOT NULL DEFAULT false,
  require_standard_value_key boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, category),
  CONSTRAINT work_center_category_key_ck CHECK (category ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT work_center_category_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT work_center_category_version_ck CHECK (version > 0)
);

CREATE TABLE work_center (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  work_center varchar(8) NOT NULL,
  category varchar(4) NOT NULL,
  description varchar(40) NOT NULL,
  person_responsible varchar(3),
  location varchar(10),
  usage varchar(3),
  standard_value_key varchar(4),
  control_key varchar(4),
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  scheduling_capacity_category varchar(3),
  scheduling_setup_formula varchar(6),
  scheduling_processing_formula varchar(6),
  scheduling_teardown_formula varchar(6),
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, plant, work_center),
  CONSTRAINT work_center_plant_fk
    FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT work_center_category_fk
    FOREIGN KEY (client, category) REFERENCES work_center_category (client, category) ON DELETE RESTRICT,
  CONSTRAINT work_center_key_ck CHECK (work_center ~ '^[A-Z0-9-]{1,8}$'),
  CONSTRAINT work_center_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT work_center_deletion_ck CHECK (deletion_flag IN ('X', ' ')),
  CONSTRAINT work_center_version_ck CHECK (version > 0)
);

CREATE INDEX work_center_category_idx ON work_center (client, category);

CREATE TABLE work_center_capacity (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  work_center varchar(8) NOT NULL,
  capacity_category varchar(3) NOT NULL,
  description varchar(40),
  factory_calendar char(2),
  base_unit varchar(6),
  start_time varchar(5),
  end_time varchar(5),
  break_minutes integer NOT NULL DEFAULT 0,
  utilization numeric(5, 2),
  individual_capacities integer,
  finite_scheduling char(1) NOT NULL DEFAULT ' ',
  long_term_planning char(1) NOT NULL DEFAULT ' ',
  several_operations char(1) NOT NULL DEFAULT ' ',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, plant, work_center, capacity_category),
  CONSTRAINT work_center_capacity_center_fk
    FOREIGN KEY (client, plant, work_center) REFERENCES work_center (client, plant, work_center) ON DELETE CASCADE,
  CONSTRAINT work_center_capacity_calendar_fk
    FOREIGN KEY (client, factory_calendar) REFERENCES factory_calendar (client, calendar_id),
  CONSTRAINT work_center_capacity_unit_fk
    FOREIGN KEY (base_unit) REFERENCES unit_of_measure (code),
  CONSTRAINT work_center_capacity_category_ck CHECK (capacity_category ~ '^[A-Z0-9]{1,3}$'),
  CONSTRAINT work_center_capacity_break_ck CHECK (break_minutes >= 0),
  CONSTRAINT work_center_capacity_flags_ck CHECK (
    finite_scheduling IN ('X', ' ')
    AND long_term_planning IN ('X', ' ')
    AND several_operations IN ('X', ' ')
  )
);

CREATE TABLE work_center_costing (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  work_center varchar(8) NOT NULL,
  line_number integer NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  controlling_area varchar(4) NOT NULL,
  cost_center varchar(10) NOT NULL,
  activity_type varchar(6),
  formula varchar(6),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, plant, work_center, line_number),
  CONSTRAINT work_center_costing_center_fk
    FOREIGN KEY (client, plant, work_center) REFERENCES work_center (client, plant, work_center) ON DELETE CASCADE,
  CONSTRAINT work_center_costing_line_ck CHECK (line_number > 0),
  CONSTRAINT work_center_costing_dates_ck CHECK (valid_to >= valid_from)
);

ALTER TABLE work_center_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_center_category FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_center_category
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON work_center_category FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_center_category TO cairn_app;

ALTER TABLE work_center ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_center FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_center
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON work_center FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_center TO cairn_app;

ALTER TABLE work_center_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_center_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_center_capacity
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON work_center_capacity FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_center_capacity TO cairn_app;

ALTER TABLE work_center_costing ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_center_costing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_center_costing
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON work_center_costing FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_center_costing TO cairn_app;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.PROD.WORKCENTER.DEFINE',
  'PRODUCTION',
  NULL,
  'Define work centres',
  'DEFINE',
  'CFG.COST.COSTCENTER.DEFINE',
  'A work center a later routing can name. This screen does not create a routing.',
  966,
  'ONBOARDING',
  '/production/work-centers',
  true,
  'MIGRATION_9158'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9158',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.WORKCENTER.DEFINE', 'NOT_STARTED', 'MIGRATION_9158'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  ('PROD.WORKCENTER.CREATE', 'PROD', 'CREATE', false, 'Create a work center. CR01 is a search alias. Saving does not schedule, cost, or create a routing.'),
  ('PROD.WORKCENTER.CHANGE', 'PROD', 'CHANGE', false, 'Change a work center. CR02 is a search alias. The category is fixed. Saving does not rewrite an order.'),
  ('PROD.WORKCENTER.DISPLAY', 'PROD', 'DISPLAY', false, 'Display a work center. CR03 is a search alias. Display writes nothing.')
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES
  (
    gen_random_uuid()::text, 'PROD.WORKCENTER.CREATE', 'work_center', 'Create work center',
    'TRANSACTION', 'PROD',
    'Create a work center in a plant. CR01 is a search alias. A formula is stored and not calculated. No routing is created.',
    'TIER_1_BUILT', '/production/work-centers', 'B', 'MIGRATION_9158'
  ),
  (
    gen_random_uuid()::text, 'PROD.WORKCENTER.CHANGE', null, 'Change work center',
    'TRANSACTION', 'PROD',
    'Change a work center. CR02 is a search alias. The category cannot be changed. Historical orders are not rewritten.',
    'TIER_1_BUILT', '/production/work-centers', 'B', 'MIGRATION_9158'
  ),
  (
    gen_random_uuid()::text, 'PROD.WORKCENTER.DISPLAY', null, 'Display work center',
    'TRANSACTION', 'PROD',
    'Display a work center. CR03 is a search alias. Display writes nothing.',
    'TIER_1_BUILT', '/production/work-center-display', 'B', 'MIGRATION_9158'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9158',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9158'
FROM (VALUES
  ('PROD.WORKCENTER.CREATE', 'CR01'),
  ('PROD.WORKCENTER.CHANGE', 'CR02'),
  ('PROD.WORKCENTER.DISPLAY', 'CR03')
) AS v(our_code, alias)
JOIN term_registry t ON t.our_code = v.our_code
ON CONFLICT (external_system, alias) DO NOTHING;
