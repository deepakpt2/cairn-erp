-- SCR-068 / R-116 (stage 2): incoming payment records.
--
-- The payment journal and the cleared lines are the clearing record;
-- this table is the payment's own evidence — what was received,
-- against whom, under which journal, and the caller's request key
-- that makes a retried submission return the standing payment.
-- A posted payment is never edited or deleted.
create table public.incoming_payment (
  client varchar(4) not null references public.client(client) on delete cascade,
  payment_number varchar(20) not null,
  fiscal_year integer not null,
  customer_number varchar(20) not null,
  company_code varchar(10) not null,
  document_date date not null,
  posting_date date not null,
  clearing_date date not null,
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
  constraint incoming_payment_amount_ck check (amount > 0 and items_cleared > 0)
);
--> statement-breakpoint
create unique index incoming_payment_request_key_uq
  on public.incoming_payment (client, request_key) where request_key is not null;
