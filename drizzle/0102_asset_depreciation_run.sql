-- SCR-094 / R-142 (stage 2): depreciation run.
--
-- The asset class gains depreciation-expense determination; the
-- run header and its items stand as the execution log; posted
-- depreciation stands per asset, area and period as a value
-- record the retirement reversal reads. The journal remains the
-- financial authority — none of these is a second ledger.
alter table public.asset_class add column depreciation_expense_account varchar(10);
--> statement-breakpoint
create table public.asset_depreciation_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(36) not null,
  company_code varchar(10) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  run_type varchar(1) not null,
  is_test_run boolean not null default true,
  posting_date date not null,
  document_type varchar(12),
  status varchar(24) not null,
  total_calculated_amount numeric(23, 4) not null default 0,
  total_posted_amount numeric(23, 4) not null default 0,
  currency char(3) not null,
  document_number varchar(40),
  document_fiscal_year integer,
  restart_of_run_id varchar(36),
  error_message text,
  executed_by varchar(60) not null,
  started_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, run_id),
  constraint asset_depreciation_run_type_ck check (run_type in ('1', '2', '3', '4')),
  constraint asset_depreciation_run_status_ck
    check (status in ('SIMULATED', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED')),
  constraint asset_depreciation_run_period_ck check (posting_period between 1 and 16)
);
--> statement-breakpoint
create index asset_depreciation_run_company_idx
  on public.asset_depreciation_run (client, company_code, fiscal_year, posting_period);
--> statement-breakpoint
create table public.asset_depreciation_run_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(36) not null,
  item_number integer not null,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  area_code varchar(2) not null,
  depreciation_key varchar(4) not null,
  calculated_amount numeric(23, 4) not null default 0,
  previously_posted_amount numeric(23, 4) not null default 0,
  adjustment_amount numeric(23, 4) not null default 0,
  currency char(3) not null,
  expense_account varchar(10),
  accum_account varchar(10),
  cost_center varchar(20),
  profit_center varchar(20),
  item_status varchar(12) not null,
  document_number varchar(40),
  message text,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, run_id, item_number),
  constraint asset_depreciation_run_item_run_fk
    foreign key (client, run_id)
    references public.asset_depreciation_run (client, run_id),
  constraint asset_depreciation_run_item_asset_fk
    foreign key (client, company_code, asset_number, sub_number)
    references public.fixed_asset (client, company_code, asset_number, sub_number),
  constraint asset_depreciation_run_item_status_ck
    check (item_status in ('CALCULATED', 'POSTED', 'SKIPPED', 'FAILED')),
  constraint asset_depreciation_run_item_amount_ck check (calculated_amount >= 0)
);
--> statement-breakpoint
create unique index asset_depreciation_run_item_asset_uk
  on public.asset_depreciation_run_item (client, run_id, company_code, asset_number, sub_number, area_code);
--> statement-breakpoint
create index asset_depreciation_run_item_asset_idx
  on public.asset_depreciation_run_item (client, company_code, asset_number, sub_number, area_code, item_status);
--> statement-breakpoint
create table public.asset_depreciation_posting (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  area_code varchar(2) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  posted_amount numeric(23, 4) not null default 0,
  currency char(3) not null,
  run_id varchar(36) not null,
  document_number varchar(40),
  document_fiscal_year integer,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, company_code, asset_number, sub_number, area_code, fiscal_year, posting_period),
  constraint asset_depreciation_posting_asset_fk
    foreign key (client, company_code, asset_number, sub_number)
    references public.fixed_asset (client, company_code, asset_number, sub_number)
);
--> statement-breakpoint
create index asset_depreciation_posting_asset_idx
  on public.asset_depreciation_posting (client, company_code, asset_number, sub_number, area_code);
