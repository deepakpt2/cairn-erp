-- A physical inventory item may name a batch that already stands.
-- Existing items stay on the blank batch. The count does not create the batch.

ALTER TABLE physical_inventory_item
  ADD COLUMN batch_number varchar(40) NOT NULL DEFAULT '';
