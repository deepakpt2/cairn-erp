-- SCR-082 / R-130 (stage 2): the down-payment clearing record.
--
-- One row per posted clearing (a KZ transfer journal); the journal
-- lines and their clearing stamps carry the per-item truth, so no
-- item-mapping table is created.
create table public.vendor_down_payment_clearing (
  client varchar(4) not null references public.client(client) on delete cascade,
  clearing_number varchar(20) not null,
  fiscal_year integer not null,
  vendor_number varchar(20) not null,
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
  constraint vendor_down_payment_clearing_amount_ck check (total_applied > 0)
);
