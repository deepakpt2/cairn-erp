-- SCR-150 — the recount's missing link.
--
-- A recount is a new physical inventory document. The original item and the recount item do not
-- already remember each other. This table is that lineage. It is not a second count and not a
-- second balance. The key is the pair of items, so a later generation is a new row and does not
-- overwrite the earlier link. A cancelled link stays.
--
-- One original item has one link that is not cancelled. That partial unique index is the
-- invariant, created with the table: an empty table has nothing to measure, and there is no
-- existing table to explain it against. The name carries no transaction alias.
--
-- The reverse read — given the recount document, find the source — cannot use the primary key,
-- which starts at the original document. Measured on 20,000 links in cairn_b210:
--
--   a miss with no recount-side index scanned every row: 2.354 ms, 228 buffers.
--   a hit of one recount document did the same: 2.376 ms, 228 buffers.
--   a unique index on (client, recount document, recount year, recount item) was selected for
--   both. The miss was 0.049 ms and 2 buffers. The hit was 0.016 ms and 3 buffers.
--
-- That index is unique because a recount item has one source. A second, non-unique index on the
-- same columns would be a duplicate, and it is not added. The active-original lookup uses the
-- partial unique index (0.009 ms, 3 buffers on the same volume).

create table if not exists public.physical_inventory_recount_link (
  client varchar(4) not null references public.client (client) on delete cascade,
  original_document_number varchar(24) not null,
  original_fiscal_year integer not null,
  original_item_number integer not null,
  recount_document_number varchar(24) not null,
  recount_fiscal_year integer not null,
  recount_item_number integer not null,
  reason varchar(40) not null,
  header_text varchar(40),
  planned_recount_date varchar(10) not null,
  status varchar(16) not null default 'SCHEDULED',
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint physical_inventory_recount_link_pk
    primary key (
      client,
      original_document_number, original_fiscal_year, original_item_number,
      recount_document_number, recount_fiscal_year, recount_item_number
    ),
  constraint physical_inventory_recount_link_original_fk
    foreign key (client, original_document_number, original_fiscal_year, original_item_number)
    references public.physical_inventory_item (client, inventory_document_number, fiscal_year, item_number)
    on delete restrict,
  constraint physical_inventory_recount_link_recount_fk
    foreign key (client, recount_document_number, recount_fiscal_year, recount_item_number)
    references public.physical_inventory_item (client, inventory_document_number, fiscal_year, item_number)
    on delete restrict,
  constraint physical_inventory_recount_link_status_ck
    check (status in ('SCHEDULED', 'COUNTED', 'RESOLVED', 'CANCELLED')),
  constraint physical_inventory_recount_link_reason_ck
    check (char_length(btrim(reason)) between 1 and 40),
  constraint physical_inventory_recount_link_header_ck
    check (header_text is null or char_length(btrim(header_text)) between 1 and 40),
  constraint physical_inventory_recount_link_date_ck
    check (planned_recount_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint physical_inventory_recount_link_distinct_document_ck
    check (
      original_document_number <> recount_document_number
      or original_fiscal_year <> recount_fiscal_year
    )
);

-- One active recount per original item. Cancelled generations are not in the index.
create unique index if not exists physical_inventory_recount_link_active_uq
  on public.physical_inventory_recount_link (
    client, original_document_number, original_fiscal_year, original_item_number
  )
  where status <> 'CANCELLED';

-- One source per recount item, and the reverse read the measurement selected.
create unique index if not exists physical_inventory_recount_link_recount_uq
  on public.physical_inventory_recount_link (
    client, recount_document_number, recount_fiscal_year, recount_item_number
  );

alter table public.physical_inventory_recount_link enable row level security;
alter table public.physical_inventory_recount_link force row level security;
create policy tenant_isolation on public.physical_inventory_recount_link
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.physical_inventory_recount_link from public;
grant select, insert, update, delete on public.physical_inventory_recount_link to cairn_app;
