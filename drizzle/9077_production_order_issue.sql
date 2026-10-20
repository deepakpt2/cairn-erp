-- SCR-139 (B-891/§26.903): MIGO 261 — the order stands on the material-document line.
--
-- A component issue is a material document plus its journal entry, never a third ledger
-- (§26.887, §26.897). What the line was missing is only the reference: which production
-- order consumed it, and which of the order's components it satisfied. Both are stored on
-- the line, as SAP's MSEG carries AUFNR and the reservation item.
--
-- The movement catalogue learns the fourth reference category: a movement whose origin is
-- a production order. 261 issues against it; 262 reverses one.

alter table public.material_document_line
  add column if not exists production_order_number varchar(12),
  add column if not exists production_order_item integer;

alter table public.material_document_line
  drop constraint if exists material_document_line_order_fk;
alter table public.material_document_line
  add constraint material_document_line_order_fk
  foreign key (client, production_order_number)
  references public.production_order (client, order_number) on delete restrict;

alter table public.movement_type drop constraint if exists movement_type_reference_ck;
alter table public.movement_type add constraint movement_type_reference_ck
  check (reference_category in ('PURCHASE_ORDER', 'MATERIAL_DOCUMENT', 'RESERVATION', 'PRODUCTION_ORDER'));

-- No index on the order. Every read of these lines is for one order at a time — the
-- order's consumption and its MD04 demand — so it is a handful of rows found by the
-- document's own primary key. The standing discipline is that an index is added when a
-- measurement asks for one (MB03, FB03, MB1A each refused theirs); this one has none.
