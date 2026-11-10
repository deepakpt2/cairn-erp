-- SCR-142 (B-907/§26.919): the count number carries its fiscal year, as the other
-- year-scoped objects do (RF_BELEG), so the readable display is PI-2026-0000001.
--
-- 9078 sized the column before the display was drawn. The number is allocated with the
-- document's fiscal year, which the formatter renders between the prefix and the digits —
-- the same shape accounting documents already carry — so the column takes the width the
-- formatter actually produces rather than the width SAP's bare IBLNR has.
alter table public.physical_inventory_document
  alter column inventory_document_number type varchar(24);
alter table public.physical_inventory_item
  alter column inventory_document_number type varchar(24);
