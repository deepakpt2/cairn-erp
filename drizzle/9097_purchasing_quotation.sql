-- SCR-157 — a quotation prices one request, and it does not buy.
--
-- One quotation per standing request. The drawn number is the key. The request
-- number is the link, not the key. The supplier is not stored again. The
-- currency is not stored again. A quotation item names a line of that request
-- and does not add one. A quantity is greater than zero. A price may be zero.
-- A price unit is a positive integer. There is no status, no revision, no
-- condition, no comparison, and no award. The order, the requisition, the info
-- record, and the request gain no quotation column.
--
-- The lookup is the request number, then its quotation. No further index is
-- added until a measurement says the unique request link is not enough.
-- The name carries no transaction alias.

create table if not exists public.purchasing_quotation (
  client varchar(4) not null references public.client (client) on delete cascade,
  quotation_number varchar(20) not null,
  rfq_number varchar(20) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_quotation_pk primary key (client, quotation_number),
  constraint purchasing_quotation_request_uq unique (client, rfq_number),
  constraint purchasing_quotation_request_pair_uq unique (client, quotation_number, rfq_number),
  constraint purchasing_quotation_request_fk
    foreign key (client, rfq_number)
    references public.purchasing_rfq (client, rfq_number)
    on delete restrict,
  constraint purchasing_quotation_number_ck check (char_length(btrim(quotation_number)) between 1 and 20)
);

create table if not exists public.purchasing_quotation_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  quotation_number varchar(20) not null,
  rfq_number varchar(20) not null,
  item_number integer not null,
  quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  net_price numeric(23, 4) not null,
  price_unit numeric(5, 0) not null,
  delivery_date date not null,
  remark varchar(80),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_quotation_item_pk primary key (client, quotation_number, item_number),
  constraint purchasing_quotation_item_header_fk
    foreign key (client, quotation_number, rfq_number)
    references public.purchasing_quotation (client, quotation_number, rfq_number)
    on delete restrict,
  constraint purchasing_quotation_item_request_item_fk
    foreign key (client, rfq_number, item_number)
    references public.purchasing_rfq_item (client, rfq_number, item_number)
    on delete restrict,
  constraint purchasing_quotation_item_unit_fk
    foreign key (unit)
    references public.unit_of_measure (code)
    on delete restrict,
  constraint purchasing_quotation_item_qty_ck check (quantity > 0),
  constraint purchasing_quotation_item_price_ck check (net_price >= 0),
  constraint purchasing_quotation_item_price_unit_ck check (price_unit > 0),
  constraint purchasing_quotation_item_remark_ck check (
    remark is null or char_length(btrim(remark)) between 1 and 80
  )
);

alter table public.purchasing_quotation enable row level security;
alter table public.purchasing_quotation force row level security;
create policy tenant_isolation on public.purchasing_quotation
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_quotation from public;
grant select, insert, update, delete on public.purchasing_quotation to cairn_app;

alter table public.purchasing_quotation_item enable row level security;
alter table public.purchasing_quotation_item force row level security;
create policy tenant_isolation on public.purchasing_quotation_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_quotation_item from public;
grant select, insert, update, delete on public.purchasing_quotation_item to cairn_app;
