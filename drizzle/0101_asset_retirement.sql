-- SCR-093 / R-141 (stage 2): asset retirement by scrapping.
--
-- The asset class gains retirement account determination, the
-- asset lifecycle gains the RETIRED state, transaction types gain
-- the RETIREMENT kind, and the retirement stands as a value record
-- linked to the canonical accounting document — not a second
-- ledger. Remaining asset values derive from ACTIVE acquisition
-- rows less ACTIVE retirement rows.
alter table public.asset_class add column accum_depr_account varchar(10);
--> statement-breakpoint
alter table public.asset_class add column retirement_loss_account varchar(10);
--> statement-breakpoint
alter table public.fixed_asset drop constraint fixed_asset_status_ck;
--> statement-breakpoint
alter table public.fixed_asset add constraint fixed_asset_status_ck
  check (status in ('ACTIVE', 'DEACTIVATED', 'RETIRED'));
--> statement-breakpoint
alter table public.asset_transaction_type drop constraint asset_transaction_type_kind_ck;
--> statement-breakpoint
alter table public.asset_transaction_type add constraint asset_transaction_type_kind_ck
  check (kind in ('ACQUISITION', 'RETIREMENT'));
--> statement-breakpoint
create table public.asset_retirement (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  document_number varchar(40) not null,
  fiscal_year integer not null,
  transaction_type varchar(4) not null,
  scope varchar(10) not null,
  retirement_percent numeric(7, 4),
  retirement_amount numeric(23, 4),
  retired_acquisition_value numeric(23, 4) not null,
  accum_depreciation_reversed numeric(23, 4) not null default 0,
  net_book_value_loss numeric(23, 4) not null default 0,
  currency char(3) not null,
  document_date date not null,
  posting_date date not null,
  asset_value_date date not null,
  reference varchar(60),
  line_text varchar(50),
  status varchar(12) not null default 'ACTIVE',
  reversal_document_number varchar(40),
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, company_code, asset_number, sub_number, document_number, fiscal_year),
  constraint asset_retirement_asset_fk
    foreign key (client, company_code, asset_number, sub_number)
    references public.fixed_asset (client, company_code, asset_number, sub_number),
  constraint asset_retirement_scope_ck check (scope in ('COMPLETE', 'PERCENT', 'AMOUNT')),
  constraint asset_retirement_status_ck check (status in ('ACTIVE', 'REVERSED')),
  constraint asset_retirement_value_ck check (retired_acquisition_value > 0),
  constraint asset_retirement_percent_ck
    check (retirement_percent is null or (retirement_percent > 0 and retirement_percent <= 100))
);
--> statement-breakpoint
create unique index asset_retirement_request_uk
  on public.asset_retirement (client, request_key)
  where request_key is not null;
--> statement-breakpoint
create index asset_retirement_asset_idx
  on public.asset_retirement (client, company_code, asset_number, sub_number, status);
