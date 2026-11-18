-- 9310_stock_transport_order.sql
--
-- ITEM-22: stock transport order (STO) without delivery, intra- and intercompany.
--
--  purchase_order            supplier_number becomes nullable; supplying_plant is the supply source of an
--                            STO. A CHECK pins the shape: a STOCK_TRANSPORT order has a supplying plant and
--                            NO supplier, every other order has a supplier and NO supplying plant. A trigger
--                            makes the document type immutable and freezes the supply side once stock moved.
--  material_document_line    sto_order_number / sto_order_item / sto_issue_document / sto_issue_line. STO
--                            movements (351, 101, 102, 352) are linked HERE and deliberately NOT through
--                            purchase_order_number, so every supplier-PO reader (GR/IR, invoice verification,
--                            vendor evaluation, delivered quantities) keeps ignoring them.
--  material_document_journal one row per accounting document a material document wrote: a cross-company 351
--                            writes TWO (one per company). material_document.journal_document_number stays as
--                            the first (sending) journal for legacy readers.
--  sto_transit_allocation    the transit ledger. One row per ORIGINAL goods-issue line (351), with the quantity
--                            and value snapshots taken at issue and the running received / reversed quantity.
--                            DB CHECKs keep received + reversed <= issued and the value consumed in step.
--  movement_type             reference category STOCK_TRANSPORT; delivered movements are seeded per tenant by
--                            the service (ensureMovements), as for every other goods movement.

alter table public.purchase_order alter column supplier_number drop not null;
alter table public.purchase_order add column if not exists supplying_plant varchar(10);
alter table public.purchase_order drop constraint if exists purchase_order_supplying_plant_fk;
alter table public.purchase_order add constraint purchase_order_supplying_plant_fk
  foreign key (client, supplying_plant) references public.plant (client, plant) on delete restrict;
alter table public.purchase_order drop constraint if exists purchase_order_sto_shape_ck;
alter table public.purchase_order add constraint purchase_order_sto_shape_ck check (
  (document_type = 'STOCK_TRANSPORT' and supplier_number is null and supplying_plant is not null)
  or (document_type <> 'STOCK_TRANSPORT' and supplier_number is not null and supplying_plant is null)
);
comment on column public.purchase_order.supplying_plant is
  'Supply source of a stock transport order (the issuing plant). Null on every supplier order.';

alter table public.movement_type drop constraint if exists movement_type_reference_ck;
alter table public.movement_type add constraint movement_type_reference_ck check (
  reference_category::text = any (array[
    'PURCHASE_ORDER', 'MATERIAL_DOCUMENT', 'RESERVATION', 'PRODUCTION_ORDER',
    'PHYSICAL_INVENTORY', 'SALES_DELIVERY', 'STOCK_TRANSPORT'
  ]::text[])
);

alter table public.material_document_line
  add column if not exists sto_order_number    varchar(20),
  add column if not exists sto_order_item      integer,
  add column if not exists sto_issue_document  varchar(20),
  add column if not exists sto_issue_line      integer;
alter table public.material_document_line drop constraint if exists material_document_line_sto_item_fk;
alter table public.material_document_line add constraint material_document_line_sto_item_fk
  foreign key (client, sto_order_number, sto_order_item)
  references public.purchase_order_item (client, order_number, item_number) on delete restrict;
alter table public.material_document_line drop constraint if exists material_document_line_sto_shape_ck;
alter table public.material_document_line add constraint material_document_line_sto_shape_ck check (
  ((sto_order_number is null) = (sto_order_item is null))
  and ((sto_issue_document is null) = (sto_issue_line is null))
  and (sto_issue_document is null or sto_order_number is not null)
);
create index if not exists material_document_line_sto_item_idx
  on public.material_document_line (client, sto_order_number, sto_order_item)
  where sto_order_number is not null;
create index if not exists material_document_line_sto_issue_idx
  on public.material_document_line (client, sto_issue_document, sto_issue_line)
  where sto_issue_document is not null;

create table if not exists public.material_document_journal (
  client                   varchar(4)  not null references public.client(client) on delete cascade,
  material_document_number varchar(20) not null,
  role                     varchar(16) not null,
  company_code             varchar(10) not null,
  journal_document_number  varchar(40) not null,
  fiscal_year              integer     not null,
  created_by               varchar(60) not null default 'SYSTEM',
  created_at               timestamp with time zone not null default now(),
  changed_by               varchar(60),
  changed_at               timestamp with time zone,
  primary key (client, material_document_number, role),
  constraint material_document_journal_doc_fk foreign key (client, material_document_number)
    references public.material_document (client, material_document_number) on delete restrict,
  constraint material_document_journal_je_fk foreign key (client, journal_document_number, fiscal_year)
    references public.journal_entry (client, document_number, fiscal_year) on delete restrict,
  constraint material_document_journal_role_ck check (role in ('SENDING', 'RECEIVING', 'PRICE_DIFFERENCE'))
);
create unique index if not exists material_document_journal_je_uq
  on public.material_document_journal (client, journal_document_number, fiscal_year);
comment on table public.material_document_journal is
  'The accounting documents a material document wrote. A cross-company STO goods issue writes one per company (SENDING, RECEIVING); a standard-priced STO receipt may write a PRICE_DIFFERENCE journal.';

create table if not exists public.sto_transit_allocation (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  issue_document     varchar(20) not null,
  issue_line         integer     not null,
  order_number       varchar(20) not null,
  item_number        integer     not null,
  material_number    varchar(40) not null,
  supplying_plant    varchar(10) not null,
  receiving_plant    varchar(10) not null,
  batch_number       varchar(40) not null default '',
  base_unit          varchar(10) not null,
  posting_date       varchar(10) not null,
  issued_quantity    numeric(23,3) not null,
  received_quantity  numeric(23,3) not null default 0,
  reversed_quantity  numeric(23,3) not null default 0,
  sending_company    varchar(10) not null,
  receiving_company  varchar(10) not null,
  source_currency    char(3)     not null,
  issue_value        numeric(23,4) not null,
  receiving_currency char(3)     not null,
  transit_value      numeric(23,4) not null,
  exchange_rate      numeric(23,8) not null default 1,
  received_value     numeric(23,4) not null default 0,
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  primary key (client, issue_document, issue_line),
  constraint sto_transit_allocation_issue_fk foreign key (client, issue_document, issue_line)
    references public.material_document_line (client, material_document_number, line_number) on delete restrict,
  constraint sto_transit_allocation_item_fk foreign key (client, order_number, item_number)
    references public.purchase_order_item (client, order_number, item_number) on delete restrict,
  constraint sto_transit_allocation_supplying_fk foreign key (client, supplying_plant)
    references public.plant (client, plant) on delete restrict,
  constraint sto_transit_allocation_receiving_fk foreign key (client, receiving_plant)
    references public.plant (client, plant) on delete restrict,
  constraint sto_transit_allocation_qty_ck check (
    issued_quantity > 0 and received_quantity >= 0 and reversed_quantity >= 0
    and received_quantity + reversed_quantity <= issued_quantity
    and (reversed_quantity = 0 or reversed_quantity = issued_quantity)
  ),
  constraint sto_transit_allocation_value_ck check (
    issue_value >= 0 and transit_value >= 0 and received_value >= 0 and received_value <= transit_value
    and exchange_rate > 0
    and (received_quantity + reversed_quantity < issued_quantity or received_value = transit_value or reversed_quantity > 0)
  ),
  constraint sto_transit_allocation_plants_ck check (supplying_plant <> receiving_plant)
);
create index if not exists sto_transit_allocation_item_idx
  on public.sto_transit_allocation (client, order_number, item_number, batch_number, posting_date, issue_document, issue_line);
create index if not exists sto_transit_allocation_receiving_idx
  on public.sto_transit_allocation (client, receiving_plant, material_number);
comment on table public.sto_transit_allocation is
  'Transit ledger: one row per original STO goods-issue (351) line. in transit = issued - reversed - received. Snapshots of quantity, value, currencies and rate are taken at issue and never rewritten.';

-- The document type of an order never changes, and once stock has moved against an STO its supply side
-- (supplying plant) is frozen. Enforced here so no code path can bypass it.
create or replace function public.purchase_order_sto_guard()
returns trigger
language plpgsql
as $$
begin
  if new.document_type is distinct from old.document_type then
    raise exception 'The document type of purchase order % cannot change (% to %).',
      old.order_number, old.document_type, new.document_type using errcode = 'check_violation';
  end if;
  if old.document_type = 'STOCK_TRANSPORT'
     and new.supplying_plant is distinct from old.supplying_plant
     and exists (
       select 1 from public.sto_transit_allocation a
        where a.client = old.client and a.order_number = old.order_number
     ) then
    raise exception 'The supplying plant of stock transport order % cannot change after stock moved.',
      old.order_number using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
alter function public.purchase_order_sto_guard() owner to cairn_integration_migrator;
drop trigger if exists purchase_order_sto_guard_trg on public.purchase_order;
create trigger purchase_order_sto_guard_trg
  before update on public.purchase_order
  for each row execute function public.purchase_order_sto_guard();

do $$
declare
  t text;
begin
  foreach t in array array['material_document_journal', 'sto_transit_allocation'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert on table public.material_document_journal to cairn_app;
grant select, insert, update on table public.sto_transit_allocation to cairn_app;
alter table public.material_document_journal owner to cairn_integration_migrator;
alter table public.sto_transit_allocation owner to cairn_integration_migrator;
