-- SCR-055 / R-103 (stage 2): purchase requisitions (ME51N).
--
-- The requisition is an item-level purchasing document: there is no
-- header record. Items carry the document type, the item category
-- (standard this round), the optional account-assignment category,
-- what is needed and where to, and the estimated price read with its
-- price unit and currency. Assignment rows hang off items; deletion
-- is a mark on the item, never physical deletion. Numbers are drawn
-- by the service from the PURCHREQ range — never MAX+1.
create table public.purchase_requisition_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  requisition_number varchar(10) not null,
  item_number integer not null,
  document_type varchar(20) not null default 'STANDARD',
  item_category varchar(16) not null default 'STANDARD',
  account_assignment_category varchar(16),
  material_number varchar(40),
  short_text varchar(40) not null,
  quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  requisition_date date not null,
  delivery_date date not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  purchasing_group varchar(3) not null,
  material_group varchar(9),
  estimated_price numeric(11, 2),
  price_unit numeric(5, 0) not null default 1,
  currency varchar(5),
  marked_for_deletion boolean not null default false,
  creation_source varchar(16) not null default 'MANUAL',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, requisition_number, item_number),
  foreign key (client, plant) references public.plant (client, plant) on delete cascade,
  foreign key (client, material_number) references public.material (client, material_number) on delete cascade,
  foreign key (client, purchasing_group) references public.purchasing_group (client, purchasing_group) on delete cascade,
  foreign key (client, plant, storage_location) references public.storage_location (client, plant, storage_location) on delete cascade,
  foreign key (client, material_group) references public.material_group (client, material_group) on delete cascade,
  constraint pr_item_quantity_ck check (quantity > 0),
  constraint pr_item_price_unit_ck check (price_unit > 0),
  constraint pr_item_number_ck check (item_number > 0),
  constraint pr_item_category_ck check (item_category in ('STANDARD')),
  constraint pr_item_assignment_category_ck check (account_assignment_category is null or account_assignment_category in ('COST_CENTER')),
  constraint pr_item_source_ck check (creation_source in ('MANUAL'))
);
--> statement-breakpoint
create index pr_item_material_plant_idx on public.purchase_requisition_item (client, material_number, plant);
--> statement-breakpoint
create table public.purchase_requisition_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  requisition_number varchar(10) not null,
  item_number integer not null,
  line_number smallint not null,
  gl_account varchar(10) not null,
  cost_center varchar(10) not null,
  distribution_percentage numeric(5, 2) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, requisition_number, item_number, line_number),
  foreign key (client, requisition_number, item_number)
    references public.purchase_requisition_item (client, requisition_number, item_number) on delete cascade,
  constraint pr_assignment_percentage_ck check (distribution_percentage > 0 and distribution_percentage <= 100),
  constraint pr_assignment_line_ck check (line_number > 0)
);
