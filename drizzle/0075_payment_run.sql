-- SCR-063 / R-111 (stage 2): the payment run.
--
-- A run is identified by its date and a five-character identification.
-- Companies and methods stand as child rows; the proposal holds what
-- would pay and the exceptions that would not; payment documents are
-- the execution's evidence and are never deleted.
create table public.payment_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(5) not null,
  posting_date date not null,
  document_cutoff_date date not null,
  next_payment_date date not null,
  supplier_from varchar(20),
  supplier_to varchar(20),
  status varchar(12) not null default 'PARAMETERS',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id),
  constraint payment_run_status_ck check (status in ('PARAMETERS', 'PROPOSAL', 'EXECUTED', 'CANCELLED'))
);
--> statement-breakpoint
create table public.payment_run_company (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(5) not null,
  company_code varchar(10) not null,
  paying_company_code varchar(10) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, company_code),
  foreign key (client, run_date, run_id)
    references public.payment_run (client, run_date, run_id) on delete cascade
);
--> statement-breakpoint
create table public.payment_run_method (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(5) not null,
  payment_method varchar(2) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, payment_method),
  foreign key (client, run_date, run_id)
    references public.payment_run (client, run_date, run_id) on delete cascade
);
--> statement-breakpoint
create table public.payment_proposal_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(5) not null,
  item_number integer not null,
  company_code varchar(10) not null,
  paying_company_code varchar(10) not null,
  account_type char(1) not null default 'K',
  account_id varchar(20) not null,
  journal_document_number varchar(40) not null,
  journal_fiscal_year integer not null,
  journal_line_number integer not null,
  invoice_number varchar(20),
  currency char(3) not null,
  amount numeric(23,4) not null,
  due_date date,
  payment_method varchar(2),
  exception_code varchar(40),
  exception_text varchar(200),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, item_number),
  foreign key (client, run_date, run_id)
    references public.payment_run (client, run_date, run_id) on delete cascade,
  constraint payment_proposal_account_type_ck check (account_type in ('K', 'D')),
  constraint payment_proposal_amount_ck check (amount >= 0)
);
--> statement-breakpoint
create table public.payment_document (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(5) not null,
  item_number integer not null,
  company_code varchar(10) not null,
  paying_company_code varchar(10) not null,
  account_id varchar(20) not null,
  currency char(3) not null,
  amount numeric(23,4) not null,
  journal_document_number varchar(40) not null,
  journal_fiscal_year integer not null,
  journal_line_number integer not null,
  invoice_number varchar(20),
  house_bank_key varchar(5) not null,
  bank_account_id varchar(5) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, item_number),
  foreign key (client, run_date, run_id)
    references public.payment_run (client, run_date, run_id) on delete restrict,
  constraint payment_document_amount_ck check (amount > 0)
);
