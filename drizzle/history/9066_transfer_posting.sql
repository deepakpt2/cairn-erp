-- SCR-131 (B-853/§26.865): the transfer posting (MB1B) is a material document of
-- two lines — an issuing line and a receiving line of one material, net zero. The
-- quantity column is positive by check, so the side is carried explicitly rather
-- than inferred from position.
--
-- 1. Every document already posted is a receipt or a reversal of one: the default
--    backfills them without touching a row.
-- 2. The movement catalogue gains a third direction, TRANSFER, because a transfer
--    is one movement type serving both of its lines.
-- 3. The stock table's non-negative guard moves into the posting path: the
--    package allows negative stock where the storage location is configured to
--    permit it (storage_location.allow_negative_stock, inert until now), and a
--    row-level check cannot see another table's configuration.

alter table public.material_document_line
  add column if not exists line_direction varchar(8) not null default 'RECEIPT';

alter table public.material_document_line
  drop constraint if exists material_document_line_direction_ck;
alter table public.material_document_line
  add constraint material_document_line_direction_ck
  check (line_direction in ('ISSUE', 'RECEIPT'));

alter table public.movement_type
  drop constraint if exists movement_type_direction_ck;
alter table public.movement_type
  add constraint movement_type_direction_ck
  check (direction in ('RECEIPT', 'REVERSAL', 'TRANSFER'));

alter table public.stock_quantity
  drop constraint if exists stock_quantity_nonnegative_ck;
