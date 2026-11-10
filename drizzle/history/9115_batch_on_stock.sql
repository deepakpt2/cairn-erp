-- A goods movement can post stock against a batch that already stands.
-- Existing balances stay on the blank batch. The primary key grows by
-- that column, so a batch is a separate balance and a null cannot bypass it.

ALTER TABLE stock_quantity
  ADD COLUMN batch_number varchar(40) NOT NULL DEFAULT '';

ALTER TABLE stock_quantity DROP CONSTRAINT stock_quantity_pkey;

ALTER TABLE stock_quantity
  ADD CONSTRAINT stock_quantity_pkey
  PRIMARY KEY (client, material_number, plant, storage_location, stock_type, batch_number);

ALTER TABLE material_document_line
  ADD COLUMN batch_number varchar(40) NOT NULL DEFAULT '';
