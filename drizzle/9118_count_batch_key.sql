-- A count may name the same material once for each batch that already stands.
-- Existing items are the blank batch, so the old material and stock-type pair stays unique.

drop index if exists public.physical_inventory_item_material_key;
create unique index physical_inventory_item_material_key
  on public.physical_inventory_item (
    client, inventory_document_number, fiscal_year, material_number, stock_type, batch_number
  );
