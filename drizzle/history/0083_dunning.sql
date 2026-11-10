-- SCR-074 / R-122 (stage 2): dunning programme.
--
-- A dunning run and everything it proposed and finalized. Selection
-- derives from the standing journal lines at run time; the run's
-- own account and item rows are the retained proposal, and the
-- notices written at finalization are records, never postings.
-- Dunning history is the completed runs' item rows.
create table public.dunning_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(6) not null,
  dunning_date date not null,
  posted_through_date date not null,
  account_type varchar(8) not null default 'CUSTOMER',
  status varchar(12) not null default 'PARAMETERS',
  customer_from varchar(40),
  customer_to varchar(40),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id),
  constraint dunning_run_id_ck check (length(run_id) between 1 and 6),
  constraint dunning_run_type_ck check (account_type = 'CUSTOMER'),
  constraint dunning_run_status_ck check (status in ('PARAMETERS', 'PROPOSED', 'COMPLETED', 'CANCELLED')),
  constraint dunning_run_cutoff_ck check (posted_through_date <= dunning_date)
);
--> statement-breakpoint
create table public.dunning_run_company (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(6) not null,
  company_code varchar(10) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, company_code),
  constraint dunning_run_company_run_fk foreign key (client, run_date, run_id)
    references public.dunning_run (client, run_date, run_id) on delete cascade
);
--> statement-breakpoint
create table public.dunning_run_account (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(6) not null,
  company_code varchar(10) not null,
  customer varchar(40) not null,
  proposed_level integer,
  currency char(3),
  total_overdue numeric(23, 4) not null default 0,
  status varchar(12) not null default 'PROPOSED',
  exception_reason varchar(500),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, company_code, customer),
  constraint dunning_run_account_company_fk foreign key (client, run_date, run_id, company_code)
    references public.dunning_run_company (client, run_date, run_id, company_code) on delete cascade,
  constraint dunning_run_account_status_ck check (status in ('PROPOSED', 'EXCLUDED', 'COMPLETED')),
  constraint dunning_run_account_level_ck check (proposed_level is null or proposed_level >= 1)
);
--> statement-breakpoint
create table public.dunning_run_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_date date not null,
  run_id varchar(6) not null,
  company_code varchar(10) not null,
  customer varchar(40) not null,
  document_number varchar(40) not null,
  fiscal_year integer not null,
  line_number integer not null,
  due_date date not null,
  days_overdue integer not null,
  overdue_amount numeric(23, 4) not null,
  currency char(3) not null,
  proposed_level integer not null,
  status varchar(12) not null default 'PROPOSED',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, run_date, run_id, company_code, customer, document_number, fiscal_year, line_number),
  constraint dunning_run_item_account_fk foreign key (client, run_date, run_id, company_code, customer)
    references public.dunning_run_account (client, run_date, run_id, company_code, customer) on delete cascade,
  constraint dunning_run_item_status_ck check (status in ('PROPOSED', 'EXCLUDED', 'COMPLETED')),
  constraint dunning_run_item_amount_ck check (overdue_amount > 0),
  constraint dunning_run_item_level_ck check (proposed_level >= 1)
);
--> statement-breakpoint
create index dunning_run_item_source_idx
  on public.dunning_run_item (client, document_number, fiscal_year, line_number);
--> statement-breakpoint
create table public.dunning_notice (
  client varchar(4) not null references public.client(client) on delete cascade,
  notice_number varchar(80) not null,
  run_date date not null,
  run_id varchar(6) not null,
  company_code varchar(10) not null,
  customer varchar(40) not null,
  dunning_level integer not null,
  currency char(3) not null,
  amount numeric(23, 4) not null,
  notice_date date not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, notice_number),
  constraint dunning_notice_level_ck check (dunning_level >= 1)
);
--> statement-breakpoint
create unique index dunning_notice_run_account_uq
  on public.dunning_notice (client, run_date, run_id, company_code, customer);
