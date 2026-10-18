-- SCR-067 / R-115 (stage 2): direct customer invoices.
--
-- A posted customer invoice is never edited or deleted; cancellation
-- is a linked mirror document. Line amounts are tax-exclusive net;
-- the gross is a judged figure the service reconciles against net
-- plus calculated tax before posting.
create table public.customer_invoice (
  client varchar(4) not null references public.client(client) on delete cascade,
  invoice_number varchar(20) not null,
  fiscal_year integer not null,
  category varchar(20) not null default 'INVOICE',
  customer_number varchar(20) not null,
  company_code varchar(10) not null,
  document_date date not null,
  posting_date date not null,
  reference varchar(16) not null,
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
  constraint customer_invoice_year_ck check (fiscal_year between 1000 and 9999),
  constraint customer_invoice_category_ck check (
    category in ('INVOICE', 'CREDIT_MEMO')
  ),
  constraint customer_invoice_status_ck check (status in ('POSTED', 'CANCELLED')),
  constraint customer_invoice_amounts_ck check (gross_amount >= 0 and tax_amount >= 0)
);
--> statement-breakpoint
create unique index customer_invoice_request_key_uq
  on public.customer_invoice (client, request_key) where request_key is not null;
--> statement-breakpoint
create index customer_invoice_duplicate_idx
  on public.customer_invoice (client, company_code, customer_number, reference);
--> statement-breakpoint
create table public.customer_invoice_line (
  client varchar(4) not null references public.client(client) on delete cascade,
  invoice_number varchar(20) not null,
  line_number integer not null,
  gl_account varchar(10) not null,
  net_amount numeric(23,4) not null,
  tax_code varchar(4),
  tax_amount numeric(23,4) not null default 0,
  profit_center varchar(20),
  line_text varchar(100),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, invoice_number, line_number),
  constraint customer_invoice_line_amount_ck check (net_amount > 0),
  foreign key (client, invoice_number)
    references public.customer_invoice (client, invoice_number) on delete restrict
);
