-- SCR-062 / R-110 (stage 2): invoice verification documents.
--
-- A posted supplier invoice is never edited or deleted; cancellation
-- is a linked mirror document. The gross amount is a judged figure:
-- the service refuses unless it equals the items' tax-exclusive net
-- total plus the calculated tax.
create table public.supplier_invoice (
  client varchar(4) not null references public.client(client) on delete cascade,
  invoice_number varchar(20) not null,
  fiscal_year integer not null,
  category varchar(20) not null default 'INVOICE',
  supplier_number varchar(20) not null,
  company_code varchar(10) not null,
  purchase_order_number varchar(20) not null,
  invoice_date date not null,
  posting_date date not null,
  supplier_reference varchar(16) not null,
  currency char(3) not null,
  gross_amount numeric(23,4) not null,
  tax_amount numeric(23,4) not null default 0,
  payment_terms varchar(12),
  baseline_date date,
  due_date date,
  header_text varchar(100),
  status varchar(12) not null default 'POSTED',
  journal_document_number varchar(40),
  cancelled_by varchar(20),
  cancellation_of varchar(20),
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, invoice_number),
  constraint supplier_invoice_year_ck check (fiscal_year between 1000 and 9999),
  constraint supplier_invoice_category_ck check (
    category in ('INVOICE', 'CREDIT_MEMO', 'SUBSEQUENT_DEBIT', 'SUBSEQUENT_CREDIT')
  ),
  constraint supplier_invoice_status_ck check (status in ('POSTED', 'CANCELLED')),
  constraint supplier_invoice_amounts_ck check (gross_amount >= 0 and tax_amount >= 0)
);
--> statement-breakpoint
create unique index supplier_invoice_request_key_uq
  on public.supplier_invoice (client, request_key) where request_key is not null;
--> statement-breakpoint
create index supplier_invoice_duplicate_idx
  on public.supplier_invoice (client, company_code, supplier_number, supplier_reference);
--> statement-breakpoint
create table public.supplier_invoice_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  invoice_number varchar(20) not null,
  line_number integer not null,
  purchase_order_number varchar(20) not null,
  purchase_order_item integer not null,
  material_number varchar(40),
  plant varchar(10),
  quantity numeric(23,3) not null,
  unit varchar(10) not null,
  net_amount numeric(23,4) not null,
  expected_amount numeric(23,4) not null,
  variance_amount numeric(23,4) not null default 0,
  tax_code varchar(4),
  tax_amount numeric(23,4) not null default 0,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, invoice_number, line_number),
  foreign key (client, invoice_number)
    references public.supplier_invoice (client, invoice_number) on delete restrict,
  constraint supplier_invoice_item_qty_ck check (quantity > 0),
  constraint supplier_invoice_item_amounts_ck check (net_amount >= 0 and expected_amount >= 0 and tax_amount >= 0)
);
--> statement-breakpoint
create index supplier_invoice_item_po_idx
  on public.supplier_invoice_item (client, purchase_order_number, purchase_order_item);
