-- CA01 / CA02 / CA03. Standard routing.
-- The chart-of-accounts key CA01 is not this transaction.
-- Type, usage, status, control key, and standard value key are tenant data. None is seeded.
-- Engineering change management is not implemented. A change number is refused.
-- Only sequence 000000 of type 0 is stored. Alternative and parallel sequences are refused.
-- A formula is not calculated. A production order is not rewritten. External processing does not create a purchase order.

CREATE TABLE routing_task_list_type (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  description varchar(40) NOT NULL,
  require_control_key char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type),
  CONSTRAINT routing_task_list_type_key_ck CHECK (task_list_type ~ '^[A-Z0-9]$'),
  CONSTRAINT routing_task_list_type_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_task_list_type_control_ck CHECK (require_control_key IN ('X', ' ')),
  CONSTRAINT routing_task_list_type_version_ck CHECK (version > 0)
);

CREATE TABLE routing_usage (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  usage varchar(3) NOT NULL,
  description varchar(40) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage),
  CONSTRAINT routing_usage_key_ck CHECK (usage ~ '^[A-Z0-9]{1,3}$'),
  CONSTRAINT routing_usage_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_usage_version_ck CHECK (version > 0)
);

CREATE TABLE routing_status (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  status varchar(3) NOT NULL,
  description varchar(40) NOT NULL,
  released_for_scheduling char(1) NOT NULL DEFAULT ' ',
  released_for_costing char(1) NOT NULL DEFAULT ' ',
  released_for_orders char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, status),
  CONSTRAINT routing_status_key_ck CHECK (status ~ '^[A-Z0-9]{1,3}$'),
  CONSTRAINT routing_status_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_status_release_ck CHECK (
    released_for_scheduling IN ('X', ' ')
    AND released_for_costing IN ('X', ' ')
    AND released_for_orders IN ('X', ' ')
  ),
  CONSTRAINT routing_status_version_ck CHECK (version > 0)
);

CREATE TABLE routing_control_key (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  control_key varchar(4) NOT NULL,
  description varchar(40) NOT NULL,
  scheduling char(1) NOT NULL DEFAULT ' ',
  costing char(1) NOT NULL DEFAULT ' ',
  confirmation char(1) NOT NULL DEFAULT ' ',
  external_processing char(1) NOT NULL DEFAULT ' ',
  require_work_center char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, control_key),
  CONSTRAINT routing_control_key_key_ck CHECK (control_key ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT routing_control_key_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_control_key_flags_ck CHECK (
    scheduling IN ('X', ' ')
    AND costing IN ('X', ' ')
    AND confirmation IN ('X', ' ')
    AND external_processing IN ('X', ' ')
    AND require_work_center IN ('X', ' ')
  ),
  CONSTRAINT routing_control_key_version_ck CHECK (version > 0)
);

CREATE TABLE routing_standard_value_key (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  standard_value_key varchar(4) NOT NULL,
  description varchar(40) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, standard_value_key),
  CONSTRAINT routing_standard_value_key_key_ck CHECK (standard_value_key ~ '^[A-Z0-9]{1,4}$'),
  CONSTRAINT routing_standard_value_key_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_standard_value_key_version_ck CHECK (version > 0)
);

CREATE TABLE routing_standard_value_parameter (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  standard_value_key varchar(4) NOT NULL,
  parameter varchar(6) NOT NULL,
  description varchar(40) NOT NULL,
  unit varchar(6) REFERENCES unit_of_measure (code),
  required char(1) NOT NULL DEFAULT ' ',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, standard_value_key, parameter),
  CONSTRAINT routing_standard_value_parameter_key_fk
    FOREIGN KEY (client, standard_value_key)
    REFERENCES routing_standard_value_key (client, standard_value_key) ON DELETE CASCADE,
  CONSTRAINT routing_standard_value_parameter_key_ck CHECK (parameter ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT routing_standard_value_parameter_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_standard_value_parameter_required_ck CHECK (required IN ('X', ' '))
);

CREATE TABLE routing (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  plant varchar(10) NOT NULL,
  description varchar(40),
  usage varchar(3) NOT NULL,
  status varchar(3),
  base_quantity numeric(23, 3) NOT NULL,
  base_unit varchar(6) NOT NULL REFERENCES unit_of_measure (code),
  lot_from numeric(23, 3),
  lot_to numeric(23, 3),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type, routing_group, group_counter),
  CONSTRAINT routing_type_fk FOREIGN KEY (client, task_list_type) REFERENCES routing_task_list_type (client, task_list_type) ON DELETE RESTRICT,
  CONSTRAINT routing_plant_fk FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT routing_usage_fk FOREIGN KEY (client, usage) REFERENCES routing_usage (client, usage) ON DELETE RESTRICT,
  CONSTRAINT routing_status_fk FOREIGN KEY (client, status) REFERENCES routing_status (client, status) ON DELETE RESTRICT,
  CONSTRAINT routing_group_ck CHECK (routing_group ~ '^[A-Z0-9]{1,8}$'),
  CONSTRAINT routing_counter_ck CHECK (group_counter ~ '^[A-Z0-9]{1,2}$'),
  CONSTRAINT routing_quantity_ck CHECK (base_quantity > 0),
  CONSTRAINT routing_lot_ck CHECK ((lot_from IS NULL AND lot_to IS NULL) OR (lot_from >= 0 AND lot_to >= lot_from)),
  CONSTRAINT routing_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT routing_text_ck CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT routing_deletion_ck CHECK (deletion_flag IN ('X', ' ')),
  CONSTRAINT routing_version_ck CHECK (version > 0)
);

CREATE UNIQUE INDEX routing_request_uq ON routing (client, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX routing_plant_idx ON routing (client, plant, usage);

CREATE TABLE routing_sequence (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  sequence char(6) NOT NULL DEFAULT '000000',
  sequence_type char(1) NOT NULL DEFAULT '0',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type, routing_group, group_counter, sequence),
  CONSTRAINT routing_sequence_header_fk
    FOREIGN KEY (client, task_list_type, routing_group, group_counter)
    REFERENCES routing (client, task_list_type, routing_group, group_counter) ON DELETE CASCADE,
  CONSTRAINT routing_sequence_standard_ck CHECK (sequence = '000000' AND sequence_type = '0')
);

CREATE TABLE routing_material_assignment (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type, routing_group, group_counter, material_number, plant),
  CONSTRAINT routing_assignment_header_fk
    FOREIGN KEY (client, task_list_type, routing_group, group_counter)
    REFERENCES routing (client, task_list_type, routing_group, group_counter) ON DELETE CASCADE,
  CONSTRAINT routing_assignment_material_fk
    FOREIGN KEY (client, material_number, plant)
    REFERENCES material_plant (client, material_number, plant) ON DELETE RESTRICT,
  CONSTRAINT routing_assignment_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT routing_assignment_deletion_ck CHECK (deletion_flag IN ('X', ' '))
);

CREATE INDEX routing_assignment_material_idx ON routing_material_assignment (client, material_number, plant);

CREATE TABLE routing_operation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  operation_number varchar(4) NOT NULL,
  sequence char(6) NOT NULL DEFAULT '000000',
  short_text varchar(40),
  plant varchar(10) NOT NULL,
  work_center varchar(8),
  control_key varchar(4),
  standard_value_key varchar(4),
  standard_text_key varchar(7),
  operation_quantity numeric(23, 3),
  operation_unit varchar(6) REFERENCES unit_of_measure (code),
  base_quantity numeric(23, 3),
  base_unit varchar(6) REFERENCES unit_of_measure (code),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type, routing_group, group_counter, operation_number),
  CONSTRAINT routing_operation_sequence_fk
    FOREIGN KEY (client, task_list_type, routing_group, group_counter, sequence)
    REFERENCES routing_sequence (client, task_list_type, routing_group, group_counter, sequence) ON DELETE CASCADE,
  CONSTRAINT routing_operation_work_center_fk
    FOREIGN KEY (client, plant, work_center)
    REFERENCES work_center (client, plant, work_center) ON DELETE RESTRICT,
  CONSTRAINT routing_operation_control_key_fk
    FOREIGN KEY (client, control_key)
    REFERENCES routing_control_key (client, control_key) ON DELETE RESTRICT,
  CONSTRAINT routing_operation_value_key_fk
    FOREIGN KEY (client, standard_value_key)
    REFERENCES routing_standard_value_key (client, standard_value_key) ON DELETE RESTRICT,
  CONSTRAINT routing_operation_number_ck CHECK (operation_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT routing_operation_sequence_ck CHECK (sequence = '000000'),
  CONSTRAINT routing_operation_text_ck CHECK (short_text IS NULL OR char_length(btrim(short_text)) BETWEEN 1 AND 40),
  CONSTRAINT routing_operation_text_key_ck CHECK (standard_text_key IS NULL OR standard_text_key ~ '^[A-Z0-9]{1,7}$'),
  CONSTRAINT routing_operation_quantity_ck CHECK (operation_quantity IS NULL OR operation_quantity > 0),
  CONSTRAINT routing_operation_base_ck CHECK (base_quantity IS NULL OR base_quantity > 0),
  CONSTRAINT routing_operation_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT routing_operation_deletion_ck CHECK (deletion_flag IN ('X', ' '))
);

CREATE INDEX routing_operation_work_center_idx ON routing_operation (client, plant, work_center);

CREATE TABLE routing_operation_value (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  operation_number varchar(4) NOT NULL,
  standard_value_key varchar(4) NOT NULL,
  parameter varchar(6) NOT NULL,
  quantity numeric(23, 3) NOT NULL,
  unit varchar(6) NOT NULL REFERENCES unit_of_measure (code),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type, routing_group, group_counter, operation_number, parameter),
  CONSTRAINT routing_operation_value_operation_fk
    FOREIGN KEY (client, task_list_type, routing_group, group_counter, operation_number)
    REFERENCES routing_operation (client, task_list_type, routing_group, group_counter, operation_number) ON DELETE CASCADE,
  CONSTRAINT routing_operation_value_parameter_fk
    FOREIGN KEY (client, standard_value_key, parameter)
    REFERENCES routing_standard_value_parameter (client, standard_value_key, parameter) ON DELETE RESTRICT,
  CONSTRAINT routing_operation_value_quantity_ck CHECK (quantity > 0)
);

CREATE TABLE routing_component_allocation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  operation_number varchar(4) NOT NULL,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  bom_usage char(1) NOT NULL,
  alternative varchar(2) NOT NULL,
  item_number varchar(4) NOT NULL,
  allocated_quantity numeric(23, 3),
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, task_list_type, routing_group, group_counter, operation_number, material_number, plant, bom_usage, alternative, item_number),
  CONSTRAINT routing_allocation_operation_fk
    FOREIGN KEY (client, task_list_type, routing_group, group_counter, operation_number)
    REFERENCES routing_operation (client, task_list_type, routing_group, group_counter, operation_number) ON DELETE CASCADE,
  CONSTRAINT routing_allocation_bom_item_fk
    FOREIGN KEY (client, material_number, plant, bom_usage, alternative, item_number)
    REFERENCES material_bom_item (client, material_number, plant, usage, alternative, item_number) ON DELETE RESTRICT,
  CONSTRAINT routing_allocation_quantity_ck CHECK (allocated_quantity IS NULL OR allocated_quantity > 0),
  CONSTRAINT routing_allocation_deletion_ck CHECK (deletion_flag IN ('X', ' '))
);

ALTER TABLE routing_task_list_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_task_list_type FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_task_list_type
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_task_list_type FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_task_list_type TO cairn_app;

ALTER TABLE routing_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_usage
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_usage FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_usage TO cairn_app;

ALTER TABLE routing_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_status
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_status FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_status TO cairn_app;

ALTER TABLE routing_control_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_control_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_control_key
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_control_key FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_control_key TO cairn_app;

ALTER TABLE routing_standard_value_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_standard_value_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_standard_value_key
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_standard_value_key FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_standard_value_key TO cairn_app;

ALTER TABLE routing_standard_value_parameter ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_standard_value_parameter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_standard_value_parameter
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_standard_value_parameter FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_standard_value_parameter TO cairn_app;

ALTER TABLE routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing TO cairn_app;

ALTER TABLE routing_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_sequence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_sequence
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_sequence FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_sequence TO cairn_app;

ALTER TABLE routing_material_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_material_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_material_assignment
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_material_assignment FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_material_assignment TO cairn_app;

ALTER TABLE routing_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_operation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_operation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_operation TO cairn_app;

ALTER TABLE routing_operation_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_operation_value FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_operation_value
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_operation_value FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_operation_value TO cairn_app;

ALTER TABLE routing_component_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_component_allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_component_allocation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON routing_component_allocation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_component_allocation TO cairn_app;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.PROD.ROUTING.DEFINE',
  'PRODUCTION',
  NULL,
  'Define routing',
  'DEFINE',
  'CFG.PROD.WORKCENTER.DEFINE',
  'A standard routing a later order can select. This screen does not schedule or confirm.',
  968,
  'ONBOARDING',
  '/production/routings',
  true,
  'MIGRATION_9160'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9160',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.ROUTING.DEFINE', 'NOT_STARTED', 'MIGRATION_9160'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  ('PROD.ROUTING.CREATE', 'PROD', 'CREATE', false, 'Create a standard routing. CA01 is a search alias. The chart-of-accounts key CA01 is not this transaction. Saving does not schedule, cost, or rewrite an order.'),
  ('PROD.ROUTING.CHANGE', 'PROD', 'CHANGE', false, 'Change a standard routing. CA02 is a search alias. A change number is refused. A saved order is not rewritten.'),
  ('PROD.ROUTING.DISPLAY', 'PROD', 'DISPLAY', false, 'Display a standard routing. CA03 is a search alias. Display writes nothing.')
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
    gen_random_uuid()::text, 'PROD.ROUTING.CREATE', 'routing', 'Create routing',
    'TRANSACTION', 'PROD',
    'Create a standard routing. CA01 is a search alias, not the chart of accounts. Group and counter identify the routing. A material assignment is separate. Only the standard sequence is stored. A formula is not calculated. A production order is not rewritten.',
    'TIER_1_BUILT', '/production/routings', 'B', 'MIGRATION_9160'
  ),
  (
    gen_random_uuid()::text, 'PROD.ROUTING.CHANGE', null, 'Change routing',
    'TRANSACTION', 'PROD',
    'Change a standard routing. CA02 is a search alias. The task list type, group, counter, and plant are fixed. Operation numbers are kept. A saved production order is not rewritten.',
    'TIER_1_BUILT', '/production/routings', 'B', 'MIGRATION_9160'
  ),
  (
    gen_random_uuid()::text, 'PROD.ROUTING.DISPLAY', null, 'Display routing',
    'TRANSACTION', 'PROD',
    'Display a standard routing. CA03 is a search alias. Display writes nothing and takes no change lock.',
    'TIER_1_BUILT', '/production/routing-display', 'B', 'MIGRATION_9160'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9160',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9160'
FROM (VALUES
  ('PROD.ROUTING.CREATE', 'CA01'),
  ('PROD.ROUTING.CHANGE', 'CA02'),
  ('PROD.ROUTING.DISPLAY', 'CA03')
) AS v(our_code, alias)
JOIN term_registry t ON t.our_code = v.our_code
ON CONFLICT (external_system, alias) DO NOTHING;
