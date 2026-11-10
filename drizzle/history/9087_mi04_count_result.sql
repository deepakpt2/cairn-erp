-- SCR-147 / MI04 — the count result lives on the item it counts.
--
-- MI01 built the document; nothing yet says what was found. The package (Part 2 §7) is explicit
-- that a second count table is only for a model that has none, and this one has an item row —
-- so the result is columns on physical_inventory_item, never a competing source.
--
-- Two things are worth stating where the database will enforce them:
--   · a count of zero and no count are different facts, so the quantity stays nullable and the
--     zero flag carries the meaning;
--   · an item now names the stock type it counts, because stockAt sums only UNRESTRICTED today
--     and a difference at material level cannot be posted to a stock type MI07 must name.

alter table public.physical_inventory_item
  add column if not exists stock_type varchar(16) not null default 'UNRESTRICTED',
  add column if not exists counted_quantity numeric(23,3),
  add column if not exists entry_unit varchar(10),
  add column if not exists counted_base_quantity numeric(23,3),
  add column if not exists zero_count_flag boolean not null default false,
  add column if not exists counter_name varchar(35),
  add column if not exists count_date varchar(10),
  add column if not exists book_quantity_snapshot numeric(23,3),
  add column if not exists book_quantity_unit varchar(10),
  add column if not exists book_quantity_basis varchar(20),
  add column if not exists difference_quantity numeric(23,3),
  add column if not exists count_status varchar(20) not null default 'UNCOUNTED',
  add column if not exists item_text varchar(60),
  add column if not exists version integer not null default 1;

-- The item lifecycle. RECOUNT_REQUIRED is in the vocabulary and unreachable this round: formal
-- recount is a conditional enhancement, and a state nothing can enter is only honest while named.
alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_count_status_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_count_status_ck
  check (count_status in ('UNCOUNTED', 'COUNTED', 'RECOUNT_REQUIRED'));

-- Zero is a state, not a number: the flag may only stand beside a real zero, and never beside
-- "no quantity at all". `is not distinct from 0` is deliberate — a null quantity fails it.
alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_zero_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_zero_ck
  check (not zero_count_flag or counted_base_quantity is not distinct from 0);

alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_count_positive_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_count_positive_ck
  check (
    (counted_quantity is null or counted_quantity >= 0)
    and (counted_base_quantity is null or counted_base_quantity >= 0)
  );

-- A completed count carries everything a completed count must: both quantities, the unit it was
-- entered in, the date it happened, and a status that says so. Half a count is not a count.
alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_count_complete_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_count_complete_ck
  check (
    (counted_base_quantity is null and count_status <> 'COUNTED')
    or (
      counted_base_quantity is not null
      and counted_quantity is not null
      and entry_unit is not null
      and count_date is not null
    )
  );

alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_count_date_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_count_date_ck
  check (count_date is null or count_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_book_basis_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_book_basis_ck
  check (book_quantity_basis is null or book_quantity_basis in ('DOCUMENT_CREATION', 'COUNT_TIME'));

-- One item per material *per stock type*: the count names the identity MI07 must post to.
drop index if exists public.physical_inventory_item_material_key;
create unique index if not exists physical_inventory_item_material_key
  on public.physical_inventory_item (
    client, inventory_document_number, fiscal_year, material_number, stock_type
  );

-- The header says where the count has got to. POSTED belongs to MI07 and DIFFERENCES_REVIEWED to
-- MI20; both are in the vocabulary so the states exist before their rounds do, and neither is
-- reachable from this round's service.
alter table public.physical_inventory_document
  drop constraint if exists physical_inventory_document_status_ck;
alter table public.physical_inventory_document
  add constraint physical_inventory_document_status_ck
  check (status in ('CREATED', 'PARTIALLY_COUNTED', 'COUNTED', 'DIFFERENCES_REVIEWED', 'POSTED', 'CANCELLED'));
