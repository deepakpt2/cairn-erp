-- SCR-084 / R-132 (stage 2): the customer down-payment clearing record.
--
-- One header row per posted clearing (a DZ transfer journal) and one
-- item row per pairwise allocation, linking the down-payment journal
-- line and the invoice journal line it settles. The journal lines
-- remain the balance authority; the header total is a summary the
-- posting reconciles to the committed allocation rows.
create table public.customer_down_payment_clearing (
  client varchar(4) not null references public.client(client) on delete cascade,
  clearing_number varchar(20) not null,
  fiscal_year integer not null,
  customer_number varchar(20) not null,
  company_code varchar(10) not null,
  special_gl_indicator varchar(1) not null,
  alternative_reconciliation_account varchar(10) not null,
  document_date date not null,
  posting_date date not null,
  clearing_date date not null,
  total_applied numeric(23, 4) not null,
  currency char(3) not null,
  reference varchar(16),
  journal_document_number varchar(40) not null,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, clearing_number),
  constraint customer_dp_clearing_amount_ck check (total_applied > 0)
);
--> statement-breakpoint
create table public.customer_down_payment_clearing_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  clearing_number varchar(20) not null,
  fiscal_year integer not null,
  mapping_number integer not null,
  down_payment_document_number varchar(40) not null,
  down_payment_fiscal_year integer not null,
  down_payment_line_number integer not null,
  invoice_document_number varchar(40) not null,
  invoice_fiscal_year integer not null,
  invoice_line_number integer not null,
  allocation_currency char(3) not null,
  allocated_amount numeric(23, 4) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, clearing_number, fiscal_year, mapping_number),
  constraint customer_dp_clearing_item_header_fk
    foreign key (client, clearing_number)
    references public.customer_down_payment_clearing (client, clearing_number),
  constraint customer_dp_clearing_item_dp_fk
    foreign key (client, down_payment_document_number, down_payment_fiscal_year, down_payment_line_number)
    references public.journal_entry_line (client, document_number, fiscal_year, line_number),
  constraint customer_dp_clearing_item_invoice_fk
    foreign key (client, invoice_document_number, invoice_fiscal_year, invoice_line_number)
    references public.journal_entry_line (client, document_number, fiscal_year, line_number),
  constraint customer_dp_clearing_item_amount_ck check (allocated_amount > 0)
);
--> statement-breakpoint
create index cdpci_down_payment_idx
  on public.customer_down_payment_clearing_item (client, down_payment_document_number, down_payment_fiscal_year);
--> statement-breakpoint
create index cdpci_invoice_idx
  on public.customer_down_payment_clearing_item (client, invoice_document_number, invoice_fiscal_year);
