-- CO01 production-version identity for a saved component snapshot.
--
-- production_order stored the material, plant, quantity, unit, and dates, but
-- not the production version, BOM usage, or BOM alternative that selected the
-- components. production_order_component.item_number is the order line. It is
-- an integer, so it cannot store an alphanumeric BOM item such as A010.
-- bom_item and source_material keep that identity on the component row.
--
-- Existing orders, and orders created from an already resolved conversion
-- snapshot, leave these columns null. A later BOM or version change does not
-- rewrite them. This does not add a reservation, a goods movement, or a journal.

ALTER TABLE production_order
  ADD COLUMN production_version varchar(4),
  ADD COLUMN bom_usage char(1),
  ADD COLUMN bom_alternative varchar(2);

ALTER TABLE production_order
  ADD CONSTRAINT production_order_bom_identity_ck
  CHECK (
    (
      production_version IS NULL
      AND bom_usage IS NULL
      AND bom_alternative IS NULL
    )
    OR (
      production_version IS NOT NULL
      AND bom_usage IS NOT NULL
      AND bom_alternative IS NOT NULL
      AND production_version ~ '^[A-Z0-9]{1,4}$'
      AND bom_usage ~ '^[A-Z0-9]$'
      AND bom_alternative ~ '^[A-Z0-9]{1,2}$'
    )
  );

ALTER TABLE production_order_component
  ADD COLUMN bom_item varchar(4),
  ADD COLUMN source_material varchar(40);

ALTER TABLE production_order_component
  ADD CONSTRAINT production_order_component_bom_item_ck
  CHECK (
    (
      bom_item IS NULL
      AND source_material IS NULL
    )
    OR (
      bom_item IS NOT NULL
      AND source_material IS NOT NULL
      AND bom_item ~ '^[A-Z0-9]{4}$'
      AND char_length(source_material) BETWEEN 1 AND 40
    )
  );

UPDATE capability
SET description = 'Create a production order. CO01 is a search alias. The screen selects a production version and stores a component snapshot from that bill of material. A typed component list or BOM alternative is not accepted on this screen. A caller that already resolved a snapshot, including planned-order conversion, may still pass that snapshot. Creating an order posts nothing and moves no stock. Release stays a separate capability.'
WHERE code = 'PROD.ORDER.CREATE';

UPDATE term_registry
SET description = 'Create a production order. CO01 is a search alias. The screen selects a production version for the material, plant, finish date, and quantity, then stores the component snapshot from that bill of material. The selected version, BOM usage, and BOM alternative are stored on the order. The BOM item and source material are stored on each component. A typed component list or a typed BOM alternative is not accepted on this screen. Planned-order conversion may still pass a snapshot it has already resolved. A later BOM or version change does not rewrite a saved snapshot. The company code is derived from the plant and never stored. Creating an order posts nothing and moves no stock. Release is a separate act. Reservations, goods movements, journals, capacity, ATP, costing, settlement, engineering change, and collective orders are not created here.',
    changed_by = 'MIGRATION_9175',
    changed_at = now()
WHERE our_code = 'PROD.ORDER.CREATE';
