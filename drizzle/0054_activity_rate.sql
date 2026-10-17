-- SCR-044 / R-93 (stage 2): the activity rate planning rows (KP26).
--
-- Activity prices are planned per cost centre, activity type, planning
-- version, fiscal year and fiscal period — the reference's six planning
-- dimensions (SAP parity, R-93). The version is a free key of at most
-- three characters; there is no version administration, a version
-- stands when it is first planned against. Periods are judged against
-- the controlling area's fiscal year variant on save — the service owns
-- the master-validity and price-indicator interplay, which needs the
-- period windows and both masters; formats, spans and the arithmetic
-- guards are declared here so the database agrees with the service.
create table public.activity_rate (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  plan_version varchar(3) not null,
  fiscal_year integer not null,
  period smallint not null,
  cost_center varchar(10) not null,
  activity_type varchar(6) not null,
  planned_quantity numeric(13,3) not null default 0,
  fixed_price numeric(11,2) not null default 0,
  variable_price numeric(11,2) not null default 0,
  price_unit integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, plan_version, fiscal_year, period, cost_center, activity_type),
  constraint activity_rate_area_format_ck check (controlling_area ~ '^[A-Z0-9]{4}$'),
  constraint activity_rate_version_format_ck check (plan_version ~ '^[A-Z0-9]{1,3}$'),
  constraint activity_rate_year_ck check (fiscal_year between 1900 and 9999),
  constraint activity_rate_period_ck check (period between 1 and 16),
  constraint activity_rate_center_format_ck check (cost_center ~ '^[A-Z0-9]{1,10}$'),
  constraint activity_rate_type_format_ck check (activity_type ~ '^[A-Z0-9]{1,6}$'),
  constraint activity_rate_quantity_ck check (planned_quantity >= 0),
  constraint activity_rate_fixed_price_ck check (fixed_price >= 0),
  constraint activity_rate_variable_price_ck check (variable_price >= 0),
  constraint activity_rate_price_unit_ck check (price_unit >= 1),
  constraint activity_rate_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area)
);
--> statement-breakpoint
