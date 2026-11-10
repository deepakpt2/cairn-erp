-- SCR-151 — the purchasing info record.
--
-- A record is a procurement default. It is not a requisition, an order, a goods movement
-- or a journal. The general row is the supplier and the material. The organisational row
-- is the purchasing organisation and, when named, the plant. A blank plant is NULL, not
-- an empty string and not a sentinel. The price row is the only price: the segment does
-- not also carry one. There is no material-group column, no company code, and no request
-- key. The name carries no transaction alias.
--
-- The lookup the order will run — supplier, material, category, then the segment, then
-- the price whose validity contains the document date — was measured on 20,000 records
-- in cairn_b210, half of them plant-specific:
--
--   a hit used purchasing_info_record_identity_uq, then the price start index, then
--   the segment primary key: 0.053 ms, 9 buffers.
--   a miss used the identity index and stopped: 0.021 ms, 2 buffers.
--
-- No further index was selected, and none is added.

create table if not exists public.purchasing_info_record (
  client varchar(4) not null references public.client (client) on delete cascade,
  info_record_number varchar(20) not null,
  partner_number varchar(40) not null,
  role_code varchar(16) not null default 'SUPPLIER',
  material_number varchar(40) not null,
  category varchar(16) not null default 'STANDARD',
  marked_for_deletion boolean not null default false,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_info_record_pk primary key (client, info_record_number),
  constraint purchasing_info_record_supplier_fk
    foreign key (client, partner_number, role_code)
    references public.bp_role (client, partner_number, role_code)
    on delete restrict,
  constraint purchasing_info_record_material_fk
    foreign key (client, material_number)
    references public.material (client, material_number)
    on delete restrict,
  constraint purchasing_info_record_role_ck check (role_code = 'SUPPLIER'),
  constraint purchasing_info_record_category_ck check (category = 'STANDARD'),
  constraint purchasing_info_record_version_ck check (version > 0),
  constraint purchasing_info_record_number_ck check (char_length(btrim(info_record_number)) between 1 and 20)
);

-- One general record per supplier, material and category. The number is the key a
-- later segment names. This index is the first step of the order's lookup.
create unique index if not exists purchasing_info_record_identity_uq
  on public.purchasing_info_record (client, partner_number, material_number, category);

create table if not exists public.purchasing_info_record_org (
  client varchar(4) not null references public.client (client) on delete cascade,
  info_record_number varchar(20) not null,
  segment_number integer not null,
  purchasing_org varchar(10) not null,
  plant varchar(10),
  planned_delivery_days integer,
  minimum_order_quantity numeric(13, 3),
  minimum_order_unit varchar(6),
  order_unit varchar(6),
  marked_for_deletion boolean not null default false,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_info_record_org_pk
    primary key (client, info_record_number, segment_number),
  constraint purchasing_info_record_org_record_fk
    foreign key (client, info_record_number)
    references public.purchasing_info_record (client, info_record_number)
    on delete restrict,
  constraint purchasing_info_record_org_org_fk
    foreign key (client, purchasing_org)
    references public.purchasing_org (client, purchasing_org)
    on delete restrict,
  constraint purchasing_info_record_org_plant_fk
    foreign key (client, plant)
    references public.plant (client, plant)
    on delete restrict,
  constraint purchasing_info_record_org_min_unit_fk
    foreign key (minimum_order_unit) references public.unit_of_measure (code),
  constraint purchasing_info_record_org_order_unit_fk
    foreign key (order_unit) references public.unit_of_measure (code),
  constraint purchasing_info_record_org_segment_ck check (segment_number > 0),
  constraint purchasing_info_record_org_version_ck check (version > 0),
  constraint purchasing_info_record_org_lead_ck
    check (planned_delivery_days is null or planned_delivery_days >= 0),
  constraint purchasing_info_record_org_minimum_ck
    check (minimum_order_quantity is null or minimum_order_quantity >= 0),
  constraint purchasing_info_record_org_minimum_pair_ck
    check ((minimum_order_quantity is null) = (minimum_order_unit is null))
);

-- One segment per organisation and plant scope. NULLS NOT DISTINCT so a second
-- organisation-level segment, whose plant is null, cannot be inserted.
create unique index if not exists purchasing_info_record_org_scope_uq
  on public.purchasing_info_record_org (client, info_record_number, purchasing_org, plant)
  nulls not distinct;

create table if not exists public.purchasing_info_record_price (
  client varchar(4) not null references public.client (client) on delete cascade,
  info_record_number varchar(20) not null,
  price_sequence integer not null,
  segment_number integer not null,
  condition_type varchar(16) not null default 'NET_PRICE',
  amount numeric(23, 4) not null,
  currency character(3) not null,
  price_unit numeric(5, 0) not null,
  price_unit_of_measure varchar(6) not null,
  valid_from date not null,
  valid_to date not null,
  marked_for_deletion boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_info_record_price_pk
    primary key (client, info_record_number, price_sequence),
  constraint purchasing_info_record_price_segment_fk
    foreign key (client, info_record_number, segment_number)
    references public.purchasing_info_record_org (client, info_record_number, segment_number)
    on delete restrict,
  constraint purchasing_info_record_price_currency_fk
    foreign key (currency) references public.currency (code),
  constraint purchasing_info_record_price_uom_fk
    foreign key (price_unit_of_measure) references public.unit_of_measure (code),
  constraint purchasing_info_record_price_sequence_ck check (price_sequence > 0),
  constraint purchasing_info_record_price_type_ck check (condition_type = 'NET_PRICE'),
  constraint purchasing_info_record_price_amount_ck check (amount >= 0),
  constraint purchasing_info_record_price_unit_ck check (price_unit > 0),
  constraint purchasing_info_record_price_validity_ck check (valid_to >= valid_from)
);

-- One price per segment, condition type and start. A later start is another row.
-- Overlap of different starts is refused by the locked service, not by an exclusion
-- constraint: the database carries no range type for this.
create unique index if not exists purchasing_info_record_price_start_uq
  on public.purchasing_info_record_price (client, info_record_number, segment_number, condition_type, valid_from);

-- The order keeps a reference to the price it qualified. The commercial columns
-- already on the item remain the snapshot. Both sides of the reference are set,
-- or neither is. Deleting the price does not take the order with it.
alter table public.purchase_order_item
  add column if not exists info_record_number varchar(20),
  add column if not exists price_sequence integer;

alter table public.purchase_order_item
  add constraint purchase_order_item_info_record_pair_ck
  check ((info_record_number is null) = (price_sequence is null));

alter table public.purchase_order_item
  add constraint purchase_order_item_info_record_price_fk
  foreign key (client, info_record_number, price_sequence)
  references public.purchasing_info_record_price (client, info_record_number, price_sequence)
  on delete restrict;

alter table public.purchasing_info_record enable row level security;
alter table public.purchasing_info_record force row level security;
create policy tenant_isolation on public.purchasing_info_record
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_info_record from public;
grant select, insert, update, delete on public.purchasing_info_record to cairn_app;

alter table public.purchasing_info_record_org enable row level security;
alter table public.purchasing_info_record_org force row level security;
create policy tenant_isolation on public.purchasing_info_record_org
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_info_record_org from public;
grant select, insert, update, delete on public.purchasing_info_record_org to cairn_app;

alter table public.purchasing_info_record_price enable row level security;
alter table public.purchasing_info_record_price force row level security;
create policy tenant_isolation on public.purchasing_info_record_price
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_info_record_price from public;
grant select, insert, update, delete on public.purchasing_info_record_price to cairn_app;
