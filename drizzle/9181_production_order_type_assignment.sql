-- Assign a production order type to a production order.
-- AUFK-AUART is the order type. It is not part of the number.
-- Existing orders stay null. Nothing is backfilled and nothing is rewritten.
-- A named type must already stand in the same tenant and be category 10.
-- An order-type parameter record is not required and is not read.
-- Checking control is not read. No availability check is added.

ALTER TABLE production_order
  ADD COLUMN order_type varchar(4);

ALTER TABLE production_order
  ADD CONSTRAINT production_order_type_ck
  CHECK (order_type IS NULL OR order_type ~ '^[A-Z0-9]{4}$');

ALTER TABLE production_order
  ADD CONSTRAINT production_order_type_fk
  FOREIGN KEY (client, order_type)
  REFERENCES production_order_type (client, order_type)
  ON DELETE RESTRICT;

COMMENT ON COLUMN production_order.order_type IS
  'Production order type. Null means not assigned. It is not filled from a scheduling profile, a material, or the first standing type.';
