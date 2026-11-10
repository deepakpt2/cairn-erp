-- 9123 restricted plant deletion, so removing a tenant could not remove the
-- plant. The plant flag belongs to the plant. Deleting the plant removes it.

ALTER TABLE batch_assigned_receipt DROP CONSTRAINT batch_assigned_receipt_plant_fk;
ALTER TABLE batch_assigned_receipt
  ADD CONSTRAINT batch_assigned_receipt_plant_fk
  FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE CASCADE;

ALTER TABLE batch_assigned_receipt
  ADD CONSTRAINT batch_assigned_receipt_client_fk
  FOREIGN KEY (client) REFERENCES client (client) ON DELETE CASCADE;
