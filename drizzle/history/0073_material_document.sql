-- SCR-061 / R-109 (stage 2): goods movements — material documents,
-- stock balances and the movement-type catalogue.
--
-- A material document is born POSTED and is never edited or deleted;
-- correction is a reversal document. Movement types are data with
-- configured semantics, never a hard-coded list in the posting path.
create table public.movement_type (
  client varchar(4) not null references public.client(client) on delete cascade,
  movement_type varchar(20) not null,
  description varchar(60) not null,
  direction varchar(10) not null,
  reference_category varchar(20) not null,
  reversal_movement_type varchar(20),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, movement_type),
  constraint movement_type_direction_ck check (direction in ('RECEIPT', 'REVERSAL')),
  constraint movement_type_reference_ck check (reference_category in ('PURCHASE_ORDER', 'MATERIAL_DOCUMENT'))
);
--> statement-breakpoint
create table public.material_document (
  client varchar(4) not null references public.client(client) on delete cascade,
  material_document_number varchar(20) not null,
  document_year integer not null,
  document_date date not null,
  posting_date date not null,
  header_text varchar(25),
  status varchar(10) not null default 'POSTED',
  journal_document_number varchar(40),
  reversal_of varchar(20),
  reversed_by varchar(20),
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, material_document_number),
  constraint material_document_year_ck check (document_year between 1000 and 9999),
  constraint material_document_status_ck check (status in ('POSTED', 'REVERSED')),
  constraint material_document_reversal_ck check (
    (reversal_of is null and reversed_by is null) or status in ('POSTED', 'REVERSED')
  )
);
--> statement-breakpoint
create unique index material_document_request_key_uq
  on public.material_document (client, request_key) where request_key is not null;
--> statement-breakpoint
create table public.material_document_line (
  client varchar(4) not null references public.client(client) on delete cascade,
  material_document_number varchar(20) not null,
  line_number integer not null,
  movement_type varchar(20) not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  stock_type varchar(16) not null default 'UNRESTRICTED',
  entry_quantity numeric(23,3) not null,
  entry_unit varchar(10) not null,
  base_quantity numeric(23,3) not null,
  base_unit varchar(10) not null,
  unit_price numeric(23,4) not null default 0,
  price_unit numeric(23,3) not null default 1,
  currency char(3),
  value numeric(23,4) not null default 0,
  purchase_order_number varchar(20),
  purchase_order_item integer,
  reversal_of_document varchar(20),
  reversal_of_line integer,
  item_text varchar(100),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, material_document_number, line_number),
  foreign key (client, material_document_number)
    references public.material_document (client, material_document_number) on delete restrict,
  foreign key (client, movement_type)
    references public.movement_type (client, movement_type) on delete restrict,
  constraint material_document_line_qty_ck check (entry_quantity > 0 and base_quantity > 0),
  constraint material_document_line_value_ck check (value >= 0 and price_unit > 0),
  constraint material_document_line_po_ck check (
    (purchase_order_number is null) = (purchase_order_item is null)
  ),
  constraint material_document_line_reversal_ck check (
    (reversal_of_document is null) = (reversal_of_line is null)
  )
);
--> statement-breakpoint
create index material_document_line_po_idx
  on public.material_document_line (client, purchase_order_number, purchase_order_item);
--> statement-breakpoint
create index material_document_line_material_idx
  on public.material_document_line (client, material_number, plant, storage_location);
--> statement-breakpoint
create table public.stock_quantity (
  client varchar(4) not null references public.client(client) on delete cascade,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  storage_location varchar(10) not null default '',
  stock_type varchar(16) not null default 'UNRESTRICTED',
  quantity numeric(23,3) not null default 0,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, material_number, plant, storage_location, stock_type),
  constraint stock_quantity_nonnegative_ck check (quantity >= 0)
);
