-- SCR-056 / R-104 (stage 2): purchase orders (ME21N).
--
-- A header with items, schedule lines and account assignments. The
-- item net value is a calculated figure with stated semantics —
-- quantity x net price / price unit, currency-rounded; condition-based
-- pricing is a later round. An item may convert a requisition item
-- (the reference stands on the item; the service judges the ordered
-- total). Deletion is an item mark. Release stands as a header status;
-- the release strategy itself is a later round.
create table public.purchase_order (
  client varchar(4) not null references public.client(client) on delete cascade,
  order_number varchar(10) not null,
  document_type varchar(20) not null default 'STANDARD',
  supplier_number varchar(40) not null,
  purchasing_org varchar(10) not null,
  purchasing_group varchar(3) not null,
  company_code varchar(10) not null,
  currency varchar(5) not null,
  document_date date not null,
  release_status varchar(16) not null default 'UNRELEASED',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number),
  foreign key (client, supplier_number) references public.business_partner (client, partner_number) on delete cascade,
  foreign key (client, purchasing_org) references public.purchasing_org (client, purchasing_org) on delete cascade,
  foreign key (client, purchasing_group) references public.purchasing_group (client, purchasing_group) on delete cascade,
  foreign key (client, company_code) references public.company_code (client, company_code) on delete cascade,
  constraint po_release_status_ck check (release_status in ('UNRELEASED', 'RELEASED'))
);
--> statement-breakpoint
create table public.purchase_order_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  order_number varchar(10) not null,
  item_number integer not null,
  item_category varchar(16) not null default 'STANDARD',
  account_assignment_category varchar(16),
  material_number varchar(40),
  short_text varchar(40) not null,
  quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  net_price numeric(11, 2) not null,
  price_unit numeric(5, 0) not null default 1,
  net_value numeric(13, 2) not null,
  tax_code varchar(4),
  plant varchar(10) not null,
  storage_location varchar(10),
  material_group varchar(9),
  requisition_number varchar(10),
  requisition_item integer,
  marked_for_deletion boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number, item_number),
  foreign key (client, order_number) references public.purchase_order (client, order_number) on delete cascade,
  foreign key (client, material_number) references public.material (client, material_number) on delete cascade,
  foreign key (client, plant) references public.plant (client, plant) on delete cascade,
  foreign key (client, plant, storage_location) references public.storage_location (client, plant, storage_location) on delete cascade,
  foreign key (client, material_group) references public.material_group (client, material_group) on delete cascade,
  foreign key (client, requisition_number, requisition_item)
    references public.purchase_requisition_item (client, requisition_number, item_number) on delete cascade,
  constraint po_item_quantity_ck check (quantity > 0),
  constraint po_item_price_ck check (net_price >= 0),
  constraint po_item_price_unit_ck check (price_unit > 0),
  constraint po_item_number_ck check (item_number > 0),
  constraint po_item_category_ck check (item_category in ('STANDARD')),
  constraint po_item_assignment_category_ck check (account_assignment_category is null or account_assignment_category in ('COST_CENTER')),
  constraint po_item_requisition_pair_ck check ((requisition_number is null) = (requisition_item is null))
);
--> statement-breakpoint
create index po_item_material_plant_idx on public.purchase_order_item (client, material_number, plant);
--> statement-breakpoint
create index po_item_requisition_idx on public.purchase_order_item (client, requisition_number, requisition_item);
--> statement-breakpoint
create table public.purchase_order_schedule_line (
  client varchar(4) not null references public.client(client) on delete cascade,
  order_number varchar(10) not null,
  item_number integer not null,
  line_number smallint not null,
  delivery_date date not null,
  quantity numeric(13, 3) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number, item_number, line_number),
  foreign key (client, order_number, item_number)
    references public.purchase_order_item (client, order_number, item_number) on delete cascade,
  constraint po_schedule_quantity_ck check (quantity > 0),
  constraint po_schedule_line_ck check (line_number > 0)
);
--> statement-breakpoint
create table public.purchase_order_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  order_number varchar(10) not null,
  item_number integer not null,
  line_number smallint not null,
  gl_account varchar(10) not null,
  cost_center varchar(10) not null,
  distribution_percentage numeric(5, 2) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number, item_number, line_number),
  foreign key (client, order_number, item_number)
    references public.purchase_order_item (client, order_number, item_number) on delete cascade,
  constraint po_assignment_percentage_ck check (distribution_percentage > 0 and distribution_percentage <= 100),
  constraint po_assignment_line_ck check (line_number > 0)
);
