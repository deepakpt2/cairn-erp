-- SCR-083 / R-131 (stage 2): the customer down-payment record.
--
-- One row per received down payment (a DZ journal); the journal
-- lines stand the accounting truth, so no clearing link table is
-- created — clearing (F-39) will carry that history on its stamps.
create table public.customer_down_payment (
  client varchar(4) not null references public.client(client) on delete cascade,
  payment_number varchar(20) not null,
  fiscal_year integer not null,
  customer_number varchar(20) not null,
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
  primary key (client, payment_number),
  constraint customer_down_payment_amount_ck check (amount > 0)
);
