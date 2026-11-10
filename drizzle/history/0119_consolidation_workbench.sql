-- SCR-116 / R-164 (stage 2): consolidation workbench (UCWB)
-- configuration. Normalized config entities only -- no
-- consolidation results, no postings, no SAP BW table names.
-- The data basis binds the standing journal provider.
create table public.consolidation_data_basis (
  client varchar(4) not null references public.client(client) on delete cascade,
  basis varchar(24) not null,
  title varchar(80) not null,
  provider varchar(12) not null default 'JOURNAL',
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, basis),
  check (provider = 'JOURNAL'),
  check (basis ~ '^[A-Z0-9_]{1,24}$')
);

create table public.consolidation_dimension (
  client varchar(4) not null references public.client(client) on delete cascade,
  basis varchar(24) not null,
  dimension varchar(24) not null,
  source_field varchar(40) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, basis, dimension),
  foreign key (client, basis)
    references public.consolidation_data_basis (client, basis) on delete cascade
);

create table public.consolidation_area (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  title varchar(80) not null,
  data_basis varchar(24) not null,
  cons_chart varchar(4) not null,
  fiscal_year_variant varchar(2) not null,
  status varchar(8) not null default 'DRAFT',
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area),
  foreign key (client, data_basis)
    references public.consolidation_data_basis (client, basis),
  foreign key (client, fiscal_year_variant)
    references public.fiscal_year_variant (client, variant),
  check (status in ('DRAFT', 'ACTIVE')),
  check (area ~ '^[A-Z0-9]{4}$')
);

create table public.consolidation_unit (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  unit varchar(10) not null,
  title varchar(80) not null,
  company_code varchar(10) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area, unit),
  foreign key (client, area)
    references public.consolidation_area (client, area) on delete cascade,
  foreign key (client, company_code)
    references public.company_code (client, company_code)
);

create table public.consolidation_group (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  group_name varchar(24) not null,
  title varchar(80) not null,
  parent_group varchar(24),
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area, group_name),
  foreign key (client, area)
    references public.consolidation_area (client, area) on delete cascade,
  foreign key (client, area, parent_group)
    references public.consolidation_group (client, area, group_name)
);

create table public.consolidation_unit_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  group_name varchar(24) not null,
  unit varchar(10) not null,
  valid_from date not null,
  valid_to date not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area, group_name, unit, valid_from),
  foreign key (client, area, group_name)
    references public.consolidation_group (client, area, group_name) on delete cascade,
  foreign key (client, area, unit)
    references public.consolidation_unit (client, area, unit) on delete cascade,
  check (valid_from <= valid_to)
);

create table public.consolidation_group_account (
  client varchar(4) not null references public.client(client) on delete cascade,
  cons_chart varchar(4) not null,
  account varchar(10) not null,
  title varchar(80) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, cons_chart, account)
);

create table public.consolidation_account_mapping (
  client varchar(4) not null references public.client(client) on delete cascade,
  cons_chart varchar(4) not null,
  source_chart varchar(4) not null,
  source_from varchar(10) not null,
  source_to varchar(10) not null,
  group_account varchar(10) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, cons_chart, source_chart, source_from, source_to),
  foreign key (client, cons_chart, group_account)
    references public.consolidation_group_account (client, cons_chart, account),
  check (source_from <= source_to)
);

create table public.consolidation_method (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  method varchar(12) not null,
  kind varchar(24) not null,
  title varchar(80) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area, method),
  foreign key (client, area)
    references public.consolidation_area (client, area) on delete cascade,
  check (kind in ('CURRENCY_TRANSLATION', 'INTERCOMPANY_ELIMINATION', 'INVESTMENT', 'OTHER'))
);

create table public.consolidation_version (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  version varchar(3) not null,
  title varchar(80) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area, version),
  foreign key (client, area)
    references public.consolidation_area (client, area) on delete cascade,
  check (version ~ '^[A-Z0-9]{1,3}$')
);

create table public.consolidation_task (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  version varchar(3) not null,
  task varchar(16) not null,
  parent_task varchar(16),
  sequence integer not null default 10,
  task_type varchar(24) not null,
  method varchar(12),
  unit varchar(10),
  group_name varchar(24),
  valid_from date not null,
  valid_to date not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, area, version, task),
  foreign key (client, area, version)
    references public.consolidation_version (client, area, version) on delete cascade,
  foreign key (client, area, version, parent_task)
    references public.consolidation_task (client, area, version, task),
  foreign key (client, area, method)
    references public.consolidation_method (client, area, method),
  foreign key (client, area, unit)
    references public.consolidation_unit (client, area, unit),
  foreign key (client, area, group_name)
    references public.consolidation_group (client, area, group_name),
  check (task_type in ('DATA_COLLECTION', 'CURRENCY_TRANSLATION', 'ELIMINATION', 'INVESTMENT', 'VALIDATION', 'OTHER')),
  check (valid_from <= valid_to),
  check (parent_task is null or parent_task <> task)
);
