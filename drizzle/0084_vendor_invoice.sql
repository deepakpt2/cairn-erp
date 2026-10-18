-- SCR-075 / R-123 (stage 2): direct vendor invoice.
--
-- The invoice-specific record beside the authoritative KR journal:
-- what the vendor billed, under which reference, at which judged
-- gross, and the cancellation links. Posted invoices are immutable;
-- correction is a linked cancellation or a credit memo.
create table public.vendor_invoice (
  client varchar(4) not null references public.client(client) on delete cascade,
  invoice_number varchar(20) not null,
  fiscal_year integer not null,
  vendor_number varchar(40) not null,
  company_code varchar(10) not null,
  document_date date not null,
  posting_date date not null,
  reference varchar(40) not null,
  currency char(3) not null,
  gross_amount numeric(23, 4) not null,
  tax_amount numeric(23, 4) not null default 0,
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
  constraint vendor_invoice_status_ck check (status in ('POSTED', 'CANCELLED')),
  constraint vendor_invoice_gross_ck check (gross_amount > 0)
);
--> statement-breakpoint
create unique index vendor_invoice_request_key_uq
  on public.vendor_invoice (client, request_key) where request_key is not null;
--> statement-breakpoint
create table public.vendor_invoice_line (
  client varchar(4) not null references public.client(client) on delete cascade,
  invoice_number varchar(20) not null,
  line_number integer not null,
  gl_account varchar(10) not null,
  net_amount numeric(23, 4) not null,
  tax_code varchar(4),
  tax_amount numeric(23, 4) not null default 0,
  cost_center varchar(20),
  profit_center varchar(20),
  line_text varchar(100),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, invoice_number, line_number),
  constraint vendor_invoice_line_invoice_fk foreign key (client, invoice_number)
    references public.vendor_invoice (client, invoice_number) on delete restrict,
  constraint vendor_invoice_line_amount_ck check (net_amount > 0)
);
