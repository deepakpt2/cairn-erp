-- SCR-149 — the difference posting's missing link, and the vocabulary it posts in.
--
-- The material document is the posting batch. It already carries the date, the actor, the
-- journal, the request key and the fingerprint. What it does not carry is the physical-inventory
-- item the line adjusted. This table is that link. It is not unique on the inventory document:
-- one document may produce several material documents, and a later selection is a later document.
-- Uniqueness sits on the material-document line. A second unique index starts at the inventory
-- item, so the remaining-quantity read has an index, and so one item cannot be allocated twice
-- inside one material document. There is no existing table to explain, and an empty table has
-- nothing to measure, so the index is created with the table. The name carries no transaction alias.
--
-- PARTIALLY_POSTED joins the header vocabulary. It is seventeen characters; the column is already
-- twenty. DIFFERENCES_REVIEWED stays in the check and stays unreachable. The item gains a posting
-- status of its own, because a count status is not a posting status. This release posts an item
-- whole, so the item vocabulary is UNPOSTED or POSTED and not a partial.
--
-- A difference movement has to be able to name its account-determination events and its modifier,
-- and to say that its reference is a physical inventory document. Those are values and columns on
-- movement_type. They are not a new determination table, and they do not name a G/L account.

alter table public.physical_inventory_document
  drop constraint if exists physical_inventory_document_status_ck;
alter table public.physical_inventory_document
  add constraint physical_inventory_document_status_ck
  check (status in (
    'CREATED', 'PARTIALLY_COUNTED', 'COUNTED', 'DIFFERENCES_REVIEWED',
    'PARTIALLY_POSTED', 'POSTED', 'CANCELLED'
  ));

alter table public.physical_inventory_item
  add column if not exists posting_status varchar(16) not null default 'UNPOSTED';

alter table public.physical_inventory_item
  drop constraint if exists physical_inventory_item_posting_status_ck;
alter table public.physical_inventory_item
  add constraint physical_inventory_item_posting_status_ck
  check (posting_status in ('UNPOSTED', 'POSTED'));

alter table public.movement_type
  add column if not exists inventory_event varchar(24),
  add column if not exists offset_event varchar(24),
  add column if not exists offset_modifier varchar(4);

alter table public.movement_type
  drop constraint if exists movement_type_reference_ck;
alter table public.movement_type
  add constraint movement_type_reference_ck
  check (reference_category in (
    'PURCHASE_ORDER', 'MATERIAL_DOCUMENT', 'RESERVATION', 'PRODUCTION_ORDER', 'PHYSICAL_INVENTORY'
  ));

alter table public.movement_type
  drop constraint if exists movement_type_inventory_event_ck;
alter table public.movement_type
  add constraint movement_type_inventory_event_ck
  check (inventory_event is null or inventory_event ~ '^[A-Z][A-Z0-9_]{2,23}$');

alter table public.movement_type
  drop constraint if exists movement_type_offset_event_ck;
alter table public.movement_type
  add constraint movement_type_offset_event_ck
  check (offset_event is null or offset_event ~ '^[A-Z][A-Z0-9_]{2,23}$');

alter table public.movement_type
  drop constraint if exists movement_type_offset_modifier_ck;
alter table public.movement_type
  add constraint movement_type_offset_modifier_ck
  check (offset_modifier is null or offset_modifier ~ '^[A-Z0-9]{1,4}$');

-- A difference movement is a receipt or an issue of the item's own stock, against a physical
-- inventory document. A valuation-relevant one has to name both events and the modifier. The
-- check refuses the row that would otherwise make the poster guess.
alter table public.movement_type
  drop constraint if exists movement_type_difference_shape_ck;
alter table public.movement_type
  add constraint movement_type_difference_shape_ck
  check (
    movement_kind <> 'INVENTORY_DIFFERENCE'
    or (
      direction in ('RECEIPT', 'ISSUE')
      and reference_category = 'PHYSICAL_INVENTORY'
      and (
        not valuation_relevant
        or (inventory_event is not null and offset_event is not null and offset_modifier is not null)
      )
    )
  );

create table if not exists public.physical_inventory_difference_allocation (
  client varchar(4) not null references public.client (client) on delete cascade,
  inventory_document_number varchar(24) not null,
  fiscal_year integer not null,
  item_number integer not null,
  count_version integer not null,
  posted_difference numeric(23, 3) not null,
  material_document_number varchar(20) not null,
  line_number integer not null,
  reversed_quantity numeric(23, 3) not null default 0,
  reversal_document_number varchar(20),
  reversal_line integer,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint physical_inventory_difference_allocation_pk
    primary key (client, material_document_number, line_number),
  constraint physical_inventory_difference_allocation_item_fk
    foreign key (client, inventory_document_number, fiscal_year, item_number)
    references public.physical_inventory_item (client, inventory_document_number, fiscal_year, item_number)
    on delete restrict,
  constraint physical_inventory_difference_allocation_line_fk
    foreign key (client, material_document_number, line_number)
    references public.material_document_line (client, material_document_number, line_number)
    on delete restrict,
  constraint physical_inventory_difference_allocation_reversal_fk
    foreign key (client, reversal_document_number, reversal_line)
    references public.material_document_line (client, material_document_number, line_number)
    on delete restrict,
  constraint physical_inventory_difference_allocation_version_ck
    check (count_version > 0),
  constraint physical_inventory_difference_allocation_posted_ck
    check (posted_difference <> 0),
  constraint physical_inventory_difference_allocation_reversed_ck
    check (reversed_quantity >= 0 and reversed_quantity <= abs(posted_difference)),
  constraint physical_inventory_difference_allocation_reversal_lineage_ck
    check (
      (reversed_quantity = 0 and reversal_document_number is null and reversal_line is null)
      or (reversed_quantity > 0 and reversal_document_number is not null and reversal_line is not null)
    )
);

-- The remaining-quantity read, and the rule that one item is allocated once per material document.
create unique index if not exists physical_inventory_difference_allocation_item_uq
  on public.physical_inventory_difference_allocation (
    client, inventory_document_number, fiscal_year, item_number, material_document_number
  );

alter table public.physical_inventory_difference_allocation enable row level security;
alter table public.physical_inventory_difference_allocation force row level security;
create policy tenant_isolation on public.physical_inventory_difference_allocation
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.physical_inventory_difference_allocation from public;
grant select, insert, update, delete on public.physical_inventory_difference_allocation to cairn_app;
