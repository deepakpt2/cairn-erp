-- Production-order operation snapshot.
--
-- A production order copied its bill of material and named a routing, but it
-- did not copy the routing's operations. Confirmation then read the live
-- routing, so a later routing edit changed what an existing order could
-- confirm. COOIS could not list a stored operation.
--
-- These rows are a copy taken when a production version selects the order.
-- They are not rewritten when the routing, control key, or standard value
-- changes. An order created from an independent component list has no rows
-- here. None are invented for it. Predecessor, successor, setup, machine,
-- labor, dates, and goods movements are not added: the routing model does not
-- store them as those fields.
--
-- Confirmation identity stays on production_confirmation. This table does not
-- replace a posted confirmation and does not post a goods movement.

CREATE TABLE IF NOT EXISTS production_order_operation (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  order_number varchar(12) NOT NULL,
  operation_number varchar(4) NOT NULL,
  sequence char(6) NOT NULL,
  task_list_type char(1) NOT NULL,
  routing_group varchar(8) NOT NULL,
  group_counter varchar(2) NOT NULL,
  production_version varchar(4) NOT NULL,
  source_operation_number varchar(4) NOT NULL,
  routing_version integer NOT NULL,
  work_center varchar(8),
  work_center_plant varchar(10) NOT NULL,
  control_key varchar(4),
  short_text varchar(40),
  standard_value_key varchar(4),
  operation_quantity numeric(23, 3),
  operation_unit varchar(6),
  base_quantity numeric(23, 3),
  base_unit varchar(6),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  confirmation char(1) NOT NULL,
  external_processing char(1) NOT NULL,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_order_operation_pk PRIMARY KEY (client, order_number, operation_number),
  CONSTRAINT production_order_operation_order_fk FOREIGN KEY (client, order_number)
    REFERENCES production_order (client, order_number) ON DELETE CASCADE,
  CONSTRAINT production_order_operation_number_ck CHECK (operation_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_order_operation_source_ck CHECK (source_operation_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT production_order_operation_sequence_ck CHECK (sequence = '000000'),
  CONSTRAINT production_order_operation_routing_ck CHECK (
    task_list_type ~ '^[A-Z0-9]$'
    AND routing_group ~ '^[A-Z0-9]{1,8}$'
    AND group_counter ~ '^[A-Z0-9]{1,2}$'
    AND production_version ~ '^[A-Z0-9]{1,4}$'
  ),
  CONSTRAINT production_order_operation_version_ck CHECK (routing_version > 0),
  CONSTRAINT production_order_operation_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT production_order_operation_flags_ck CHECK (
    confirmation IN ('X', ' ') AND external_processing IN ('X', ' ')
  ),
  CONSTRAINT production_order_operation_text_ck CHECK (
    short_text IS NULL OR char_length(btrim(short_text)) BETWEEN 1 AND 40
  )
);

CREATE INDEX IF NOT EXISTS production_order_operation_order_idx
  ON production_order_operation (client, order_number);

CREATE TABLE IF NOT EXISTS production_order_operation_value (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  order_number varchar(12) NOT NULL,
  operation_number varchar(4) NOT NULL,
  parameter varchar(6) NOT NULL,
  description varchar(40) NOT NULL,
  quantity numeric(23, 3),
  unit varchar(6) NOT NULL,
  required char(1) NOT NULL,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT production_order_operation_value_pk PRIMARY KEY (client, order_number, operation_number, parameter),
  CONSTRAINT production_order_operation_value_fk FOREIGN KEY (client, order_number, operation_number)
    REFERENCES production_order_operation (client, order_number, operation_number) ON DELETE CASCADE,
  CONSTRAINT production_order_operation_value_parameter_ck CHECK (parameter ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT production_order_operation_value_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT production_order_operation_value_quantity_ck CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT production_order_operation_value_required_ck CHECK (required IN ('X', ' '))
);

ALTER TABLE production_order_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_order_operation;
CREATE POLICY tenant_isolation ON production_order_operation
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_order_operation FROM PUBLIC;
GRANT SELECT, INSERT ON production_order_operation TO cairn_app;

ALTER TABLE production_order_operation_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_operation_value FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_order_operation_value;
CREATE POLICY tenant_isolation ON production_order_operation_value
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_order_operation_value FROM PUBLIC;
GRANT SELECT, INSERT ON production_order_operation_value TO cairn_app;
