-- SCR-133 (B-861/§26.873): MD04 reads a material's open reservations by plant and
-- material on every execution. Measured at 60,000 reservation items, that read cost
-- 9.418 ms walking every item the tenant holds; with this index it answers in
-- 0.114 ms. The screen's read of one reservation is the primary key already (0.044 ms).

create index if not exists ri_plant_material_idx
  on public.reservation_item (client, plant, material_number);
