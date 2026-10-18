-- SCR-078 / R-126 (stage 2): the outgoing payment record.
--
-- One row per posted vendor payment (F-53 shape), mirroring
-- incoming_payment width for width with the vendor in the customer's
-- place and an optional value date the bank rules will one day judge.
-- Allocations stand as clearing stamps on the journal lines — the
-- standing clearing model — not as a second allocation table.
create table public.outgoing_payment (
  client varchar(4) not null references public.client(client) on delete cascade,
  payment_number varchar(20) not null,
  fiscal_year integer not null,
  vendor_number varchar(20) not null,
  company_code varchar(10) not null,
  document_date date not null,
  posting_date date not null,
  clearing_date date not null,
  value_date date,
  bank_gl_account varchar(10) not null,
  amount numeric(23,4) not null,
  currency char(3) not null,
  reference varchar(16),
  journal_document_number varchar(40) not null,
  items_cleared integer not null,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, payment_number),
  constraint outgoing_payment_amount_positive check (amount > 0)
);
