-- SCR-092 / R-140 (stage 2): asset acquisition configuration and
-- the asset transaction value record.
--
-- The asset class gains its account determination; transaction
-- types stand as tenant configuration; the asset transaction
-- records values linked to the canonical accounting document —
-- it is not a second ledger, and asset values derive from its
-- ACTIVE rows.
alter table public.asset_class add column recon_account varchar(10);
--> statement-breakpoint
create table public.asset_transaction_type (
  client varchar(4) not null references public.client(client) on delete cascade,
  type_code varchar(4) not null,
  name varchar(60) not null,
  kind varchar(16) not null default 'ACQUISITION',
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, type_code),
  constraint asset_transaction_type_kind_ck check (kind in ('ACQUISITION'))
);
--> statement-breakpoint
create table public.asset_transaction (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  document_number varchar(40) not null,
  fiscal_year integer not null,
  transaction_type varchar(4) not null,
  document_date date not null,
  posting_date date not null,
  asset_value_date date not null,
  amount numeric(23, 4) not null,
  currency char(3) not null,
  offset_account varchar(10) not null,
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
  constraint asset_transaction_asset_fk
    foreign key (client, company_code, asset_number, sub_number)
    references public.fixed_asset (client, company_code, asset_number, sub_number),
  constraint asset_transaction_status_ck check (status in ('ACTIVE', 'REVERSED')),
  constraint asset_transaction_amount_ck check (amount > 0)
);
--> statement-breakpoint
create unique index asset_transaction_request_uk
  on public.asset_transaction (client, request_key)
  where request_key is not null;
--> statement-breakpoint
create index asset_transaction_asset_idx
  on public.asset_transaction (client, company_code, asset_number, sub_number, status);
