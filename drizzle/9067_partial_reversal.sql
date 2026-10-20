-- SCR-132 (B-857/§26.869): the general material-document reversal (MBST) may
-- reverse whole lines of a document, so a document can stand partly reversed.
-- The status column is the cancellation flag the package calls XSTBW; it gains
-- the third state. Every existing row is POSTED or REVERSED and keeps its value.

alter table public.material_document
  drop constraint if exists material_document_status_ck;
alter table public.material_document
  add constraint material_document_status_ck
  check (status in ('POSTED', 'PARTIALLY_REVERSED', 'REVERSED'));
