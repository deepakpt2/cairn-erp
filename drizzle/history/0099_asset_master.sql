-- SCR-091 / R-139 (stage 2): fixed asset master foundation.
--
-- Master data only: classes, depreciation areas and keys stand as
-- tenant configuration; the asset stands under its complete key
-- (tenant, company, main number, sub-number); assignments are
-- effective-dated intervals whose history is never rewritten;
-- depreciation parameters stand per area with useful life as
-- years and periods apart. Nothing here posts, retires or
-- depreciates — those rounds follow with their own services.
create table public.asset_class (
  client varchar(4) not null references public.client(client) on delete cascade,
  asset_class varchar(8) not null,
  name varchar(60) not null,
  numbering varchar(8) not null default 'INTERNAL',
  quantity_managed boolean not null default false,
  default_depreciation_key varchar(4),
  default_useful_life_years integer,
  default_useful_life_periods integer,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, asset_class),
  constraint asset_class_numbering_ck check (numbering in ('INTERNAL', 'EXTERNAL'))
);
--> statement-breakpoint
create table public.depreciation_area (
  client varchar(4) not null references public.client(client) on delete cascade,
  area_code varchar(2) not null,
  name varchar(60) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, area_code)
);
--> statement-breakpoint
create table public.depreciation_key (
  client varchar(4) not null references public.client(client) on delete cascade,
  key_code varchar(4) not null,
  name varchar(60) not null,
  method varchar(20) not null default 'STRAIGHT_LINE',
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, key_code)
);
--> statement-breakpoint
create table public.fixed_asset (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  asset_class varchar(8) not null,
  description_1 varchar(50) not null,
  description_2 varchar(25),
  inventory_number varchar(30),
  serial_number varchar(30),
  quantity numeric(13, 3),
  unit_of_measure varchar(3),
  capitalization_date date,
  deactivation_date date,
  status varchar(12) not null default 'ACTIVE',
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, company_code, asset_number, sub_number),
  constraint fixed_asset_status_ck check (status in ('ACTIVE', 'DEACTIVATED')),
  constraint fixed_asset_version_ck check (version > 0)
);
--> statement-breakpoint
create unique index fixed_asset_inventory_uk
  on public.fixed_asset (client, company_code, inventory_number)
  where inventory_number is not null;
--> statement-breakpoint
create index fixed_asset_class_idx
  on public.fixed_asset (client, company_code, asset_class);
--> statement-breakpoint
create table public.asset_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  valid_from date not null,
  valid_to date,
  cost_center varchar(20),
  profit_center varchar(20),
  plant varchar(10),
  location varchar(20),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, company_code, asset_number, sub_number, valid_from),
  constraint asset_assignment_asset_fk
    foreign key (client, company_code, asset_number, sub_number)
    references public.fixed_asset (client, company_code, asset_number, sub_number),
  constraint asset_assignment_interval_ck
    check (valid_to is null or valid_to > valid_from)
);
--> statement-breakpoint
create table public.asset_depreciation (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  asset_number varchar(12) not null,
  sub_number varchar(4) not null default '0000',
  area_code varchar(2) not null,
  depreciation_key varchar(4) not null,
  useful_life_years integer not null,
  useful_life_periods integer not null default 0,
  depreciation_start_date date,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, company_code, asset_number, sub_number, area_code),
  constraint asset_depreciation_asset_fk
    foreign key (client, company_code, asset_number, sub_number)
    references public.fixed_asset (client, company_code, asset_number, sub_number),
  constraint asset_depreciation_years_ck check (useful_life_years >= 0),
  constraint asset_depreciation_periods_ck check (useful_life_periods between 0 and 11),
  constraint asset_depreciation_life_ck check (useful_life_years * 12 + useful_life_periods > 0)
);
