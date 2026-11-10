-- A purchase order item and a production order may name a batch that
-- already stands. Existing orders stay on the blank batch. The posting
-- still does not create the batch.

ALTER TABLE purchase_order_item
  ADD COLUMN batch_number varchar(40) NOT NULL DEFAULT '';

ALTER TABLE production_order
  ADD COLUMN batch_number varchar(40) NOT NULL DEFAULT '';
