-- SCR-143 (B-911/§26.923): the count header carries a version, the convention the finance
-- schema already keeps for documents whose state changes in place.
--
-- The block release is also recorded as its own fact in the change document rather than as a
-- status the reader infers. Columns: none added for that — the change record carries it.
alter table public.physical_inventory_document
  add column if not exists version integer not null default 1;
