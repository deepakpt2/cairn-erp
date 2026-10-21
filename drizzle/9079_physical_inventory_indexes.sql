-- SCR-142 (B-906/§26.918): two indexes, chosen by measurement, and the package's refused.
--
-- Measured over 20,000 count documents and 80,000 items in cairn_b210.
--
-- The guard runs inside EVERY service that moves stock — goods receipt, goods issue,
-- transfer posting and production receipt — so its cost is paid on the normal path, where
-- most materials are in no count at all. Unindexed it was the worst kind of slow: a miss
-- cost MORE than a hit (15.228 ms against 10.068 ms), because it scanned all 80,000 items
-- to find nothing. With (client, material_number) a hit is 0.060 ms and a miss 0.046 ms.
create index if not exists physical_inventory_item_material_idx
  on public.physical_inventory_item (client, material_number);

-- The screen lists a plant's documents newest planned date first: 10.137 -> 0.898 ms.
create index if not exists physical_inventory_document_plant_idx
  on public.physical_inventory_document (client, plant, planned_count_date desc);

-- The package's (tenant, plant, inventory_document_number) index was built, analyzed and
-- measured: the planner did not choose it for the list (9.365 ms, still a sequential scan and
-- a sort), and the point lookups it would serve already stand on the primary key. It is not
-- carried. This book does not keep an index that no plan selects.
