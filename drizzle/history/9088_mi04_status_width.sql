-- SCR-147 — PARTIALLY_COUNTED is seventeen characters and the header status column was sixteen.
--
-- 9087 widened the vocabulary and the check refused to be satisfied by a value that would not fit;
-- the column follows the state it now has to hold.
alter table public.physical_inventory_document
  alter column status type varchar(20);

alter table public.physical_inventory_item
  alter column count_status type varchar(24);
