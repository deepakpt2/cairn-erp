-- SCR-081 / R-129 (stage 2): special G/L configuration and the
-- vendor down-payment record.
--
-- The configuration names the alternative reconciliation account a
-- special G/L indicator posts to (company scope '' is the
-- tenant-wide default). The record remembers each down payment;
-- the KA journal lines stand the accounting truth, so no clearing
-- link table is created — clearing stamps will carry that history.
create table public.special_gl_config (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null default '',
  account_type varchar(2) not null,
  indicator varchar(1) not null,
  alternative_reconciliation_account varchar(10) not null,
  description varchar(60) not null default '',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  constraint special_gl_config_pk primary key (client, company_code, account_type, indicator),
  constraint special_gl_account_type_ck check (account_type in ('AP', 'AR'))
);
--> statement-breakpoint
create table public.vendor_down_payment (
  client varchar(4) not null references public.client(client) on delete cascade,
  payment_number varchar(20) not null,
  fiscal_year integer not null,
  vendor_number varchar(20) not null,
  company_code varchar(10) not null,
  document_date date not null,
  posting_date date not null,
  value_date date,
  bank_gl_account varchar(10) not null,
  special_gl_indicator varchar(1) not null,
  alternative_reconciliation_account varchar(10) not null,
  amount numeric(23, 4) not null,
  currency char(3) not null,
  reference varchar(16),
  header_text varchar(100),
  journal_document_number varchar(40) not null,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  constraint vendor_down_payment_pk primary key (client, payment_number),
  constraint vendor_down_payment_amount_ck check (amount > 0)
);
