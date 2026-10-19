-- SCR-098 / R-146 (stage 2): FX valuation run header and item
-- protocol. No equivalent audit structure exists, so these two
-- tables are added; canonical documents, rates and balances are
-- reused untouched. House naming throughout (client; run ids in
-- the house TX-style sequence, never SAP run keys).
create table public.fx_valuation_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  request_key varchar(64) not null,
  company_code varchar(10) not null,
  fiscal_year integer not null,
  valuation_area varchar(6) not null,
  valuation_key_date date not null,
  posting_date date not null,
  reversal_date date,
  valuation_method varchar(12) not null,
  document_type varchar(12) not null,
  is_test_run boolean not null default true,
  include_open_items boolean not null default true,
  include_balances boolean not null default true,
  status varchar(12) not null default 'TEST',
  total_gain_amount numeric(23, 4) not null default 0,
  total_loss_amount numeric(23, 4) not null default 0,
  posting_document_number varchar(40),
  reversal_document_number varchar(40),
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  primary key (client, run_id),
  unique (client, request_key),
  check (status in ('TEST', 'COMPLETED', 'REVERSED'))
);
--> statement-breakpoint
create table public.fx_valuation_item (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  company_code varchar(10) not null,
  fiscal_year integer not null,
  valuation_area varchar(6) not null,
  item_number integer not null,
  source_kind varchar(12) not null,
  account_number varchar(10) not null,
  source_document varchar(40),
  source_line integer,
  currency char(3) not null,
  foreign_amount numeric(23, 4) not null,
  carrying_amount numeric(23, 4) not null,
  valuation_rate numeric(18, 8),
  rate_type varchar(12) not null,
  required_amount numeric(23, 4),
  adjustment_amount numeric(23, 4),
  classification varchar(8),
  posting_document varchar(40),
  status varchar(12) not null,
  error text,
  primary key (client, run_id, item_number),
  foreign key (client, run_id) references public.fx_valuation_run (client, run_id) on delete cascade,
  check (source_kind in ('OPEN_ITEM', 'BALANCE')),
  check (classification is null or classification in ('GAIN', 'LOSS', 'NONE')),
  check (status in ('CALCULATED', 'POSTED', 'SKIPPED', 'ERROR'))
);
--> statement-breakpoint
create index fx_valuation_item_source_idx
  on public.fx_valuation_item (client, company_code, valuation_area, source_document, source_line, status);
