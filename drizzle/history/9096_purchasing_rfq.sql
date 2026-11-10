-- SCR-155 — a request for quotation asks, and it does not buy.
--
-- One sourcing event groups the requirement. Each invited supplier receives a
-- separate request, and that request copies the lines. The event number and
-- the request number are the keys. A collective number is an optional label,
-- not unique and not the key. There is no status, no company code, no price,
-- no quotation, no delivery attempt, and no request key. The name carries no
-- transaction alias.
--
-- The request's lines must belong to that request's event. One supplier is
-- invited once. Item numbers step by ten. A quantity is greater than zero.
-- The deadline is on or after the RFQ date. Deleting an event that still has
-- lines, or a request that still has its copy, is refused. The order and the
-- requisition are not given a request column.
--
-- The lookup is the event number, then its requests. No further index is added
-- until a measurement says these keys are not enough.

create table if not exists public.purchasing_rfq_event (
  client varchar(4) not null references public.client (client) on delete cascade,
  event_number varchar(20) not null,
  document_type varchar(20) not null default 'STANDARD',
  purchasing_org varchar(10) not null,
  purchasing_group varchar(3) not null,
  rfq_date date not null,
  quotation_deadline date not null,
  currency char(3) not null,
  collective_number varchar(10),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_rfq_event_pk primary key (client, event_number),
  constraint purchasing_rfq_event_org_fk
    foreign key (client, purchasing_org)
    references public.purchasing_org (client, purchasing_org)
    on delete restrict,
  constraint purchasing_rfq_event_group_fk
    foreign key (client, purchasing_group)
    references public.purchasing_group (client, purchasing_group)
    on delete restrict,
  constraint purchasing_rfq_event_currency_fk
    foreign key (currency)
    references public.currency (code)
    on delete restrict,
  constraint purchasing_rfq_event_type_ck check (document_type = 'STANDARD'),
  constraint purchasing_rfq_event_number_ck check (char_length(btrim(event_number)) between 1 and 20),
  constraint purchasing_rfq_event_deadline_ck check (quotation_deadline >= rfq_date),
  constraint purchasing_rfq_event_currency_ck check (btrim(currency) ~ '^[A-Z]{3}$'),
  constraint purchasing_rfq_event_collective_ck check (
    collective_number is null or char_length(btrim(collective_number)) between 1 and 10
  )
);

create table if not exists public.purchasing_rfq_event_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  event_number varchar(20) not null,
  item_number integer not null,
  short_text varchar(40) not null,
  material_number varchar(40),
  quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  delivery_date date not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_rfq_event_item_pk primary key (client, event_number, item_number),
  constraint purchasing_rfq_event_item_event_fk
    foreign key (client, event_number)
    references public.purchasing_rfq_event (client, event_number)
    on delete restrict,
  constraint purchasing_rfq_event_item_material_fk
    foreign key (client, material_number)
    references public.material (client, material_number)
    on delete restrict,
  constraint purchasing_rfq_event_item_plant_fk
    foreign key (client, plant)
    references public.plant (client, plant)
    on delete restrict,
  constraint purchasing_rfq_event_item_storage_fk
    foreign key (client, plant, storage_location)
    references public.storage_location (client, plant, storage_location)
    on delete restrict,
  constraint purchasing_rfq_event_item_unit_fk
    foreign key (unit)
    references public.unit_of_measure (code)
    on delete restrict,
  constraint purchasing_rfq_event_item_number_ck check (item_number > 0 and item_number % 10 = 0),
  constraint purchasing_rfq_event_item_qty_ck check (quantity > 0),
  constraint purchasing_rfq_event_item_text_ck check (char_length(btrim(short_text)) between 1 and 40)
);

create table if not exists public.purchasing_rfq (
  client varchar(4) not null references public.client (client) on delete cascade,
  rfq_number varchar(20) not null,
  event_number varchar(20) not null,
  partner_number varchar(40) not null,
  role_code varchar(16) not null default 'SUPPLIER',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_rfq_pk primary key (client, rfq_number),
  constraint purchasing_rfq_event_number_uq unique (client, rfq_number, event_number),
  constraint purchasing_rfq_event_fk
    foreign key (client, event_number)
    references public.purchasing_rfq_event (client, event_number)
    on delete restrict,
  constraint purchasing_rfq_supplier_fk
    foreign key (client, partner_number, role_code)
    references public.bp_role (client, partner_number, role_code)
    on delete restrict,
  constraint purchasing_rfq_supplier_uq unique (client, event_number, partner_number),
  constraint purchasing_rfq_role_ck check (role_code = 'SUPPLIER'),
  constraint purchasing_rfq_number_ck check (char_length(btrim(rfq_number)) between 1 and 20)
);

create table if not exists public.purchasing_rfq_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  rfq_number varchar(20) not null,
  event_number varchar(20) not null,
  item_number integer not null,
  short_text varchar(40) not null,
  material_number varchar(40),
  quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  delivery_date date not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_rfq_item_pk primary key (client, rfq_number, item_number),
  constraint purchasing_rfq_item_header_fk
    foreign key (client, rfq_number, event_number)
    references public.purchasing_rfq (client, rfq_number, event_number)
    on delete restrict,
  constraint purchasing_rfq_item_event_item_fk
    foreign key (client, event_number, item_number)
    references public.purchasing_rfq_event_item (client, event_number, item_number)
    on delete restrict,
  constraint purchasing_rfq_item_material_fk
    foreign key (client, material_number)
    references public.material (client, material_number)
    on delete restrict,
  constraint purchasing_rfq_item_plant_fk
    foreign key (client, plant)
    references public.plant (client, plant)
    on delete restrict,
  constraint purchasing_rfq_item_storage_fk
    foreign key (client, plant, storage_location)
    references public.storage_location (client, plant, storage_location)
    on delete restrict,
  constraint purchasing_rfq_item_unit_fk
    foreign key (unit)
    references public.unit_of_measure (code)
    on delete restrict,
  constraint purchasing_rfq_item_number_ck check (item_number > 0 and item_number % 10 = 0),
  constraint purchasing_rfq_item_qty_ck check (quantity > 0),
  constraint purchasing_rfq_item_text_ck check (char_length(btrim(short_text)) between 1 and 40)
);

alter table public.purchasing_rfq_event enable row level security;
alter table public.purchasing_rfq_event force row level security;
create policy tenant_isolation on public.purchasing_rfq_event
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_rfq_event from public;
grant select, insert, update, delete on public.purchasing_rfq_event to cairn_app;

alter table public.purchasing_rfq_event_item enable row level security;
alter table public.purchasing_rfq_event_item force row level security;
create policy tenant_isolation on public.purchasing_rfq_event_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_rfq_event_item from public;
grant select, insert, update, delete on public.purchasing_rfq_event_item to cairn_app;

alter table public.purchasing_rfq enable row level security;
alter table public.purchasing_rfq force row level security;
create policy tenant_isolation on public.purchasing_rfq
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_rfq from public;
grant select, insert, update, delete on public.purchasing_rfq to cairn_app;

alter table public.purchasing_rfq_item enable row level security;
alter table public.purchasing_rfq_item force row level security;
create policy tenant_isolation on public.purchasing_rfq_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_rfq_item from public;
grant select, insert, update, delete on public.purchasing_rfq_item to cairn_app;
