-- SCR-099 / R-147 (stage 2): GR/IR reclassification run header
-- and item protocol. No equivalent audit structure exists, so
-- these two tables are added; purchase orders, material documents,
-- supplier invoices and accounting documents are reused untouched.
-- House naming throughout (client, never tenant_id).
create table public.grir_reclass_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  request_key varchar(64) not null,
  company_code varchar(10) not null,
  fiscal_year integer not null,
  key_date date not null,
  posting_date date,
  reversal_date date,
  is_test_run boolean not null default true,
  create_accruals boolean not null default false,
  status varchar(12) not null default 'TEST',
  total_accrual_amount numeric(23, 4) not null default 0,
  accrual_document_number varchar(40),
  reversal_document_number varchar(40),
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  primary key (client, run_id),
  unique (client, request_key),
  check (status in ('TEST', 'COMPLETED', 'REVERSED'))
);
--> statement-breakpoint
create table public.grir_reclass_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  company_code varchar(10) not null,
  fiscal_year integer not null,
  item_number integer not null,
  purchase_order varchar(20) not null,
  purchase_order_item integer not null,
  vendor varchar(40) not null,
  material varchar(40),
  plant varchar(10) not null,
  currency varchar(3) not null,
  ordered_quantity numeric(13, 3) not null,
  received_quantity numeric(13, 3) not null,
  invoiced_quantity numeric(13, 3) not null,
  open_quantity numeric(13, 3) not null,
  received_value numeric(23, 4) not null,
  invoiced_value numeric(23, 4) not null,
  open_value numeric(23, 4) not null,
  classification varchar(28) not null,
  accrual_amount numeric(23, 4) not null default 0,
  accrual_document varchar(40),
  status varchar(12) not null,
  error text,
  primary key (client, run_id, item_number),
  foreign key (client, run_id) references public.grir_reclass_run (client, run_id) on delete cascade,
  check (classification in ('RECONCILED', 'GOODS_RECEIVED_NOT_INVOICED', 'INVOICED_NOT_RECEIVED', 'QUANTITY_DIFFERENCE', 'VALUE_DIFFERENCE')),
  check (status in ('ANALYZED', 'ACCRUED', 'SKIPPED', 'ERROR'))
);
--> statement-breakpoint
create index grir_reclass_item_po_idx
  on public.grir_reclass_item (client, company_code, purchase_order, purchase_order_item, status);
