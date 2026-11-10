-- SCR-057 / R-105 (stage 2): characteristics for classification (CT04).
--
-- The characteristic's name is its stable tenant business key (never
-- renamed); the description stands in the tenant language (language-
-- dependent texts are deferred under B-223). The lifecycle DRAFT /
-- ACTIVE / BLOCKED is a Cairn workflow, deliberately not an SAP
-- status. Allowed values stand beneath the characteristic, unique
-- under the case policy it declares (service-judged).
create table public.characteristic (
  client varchar(4) not null references public.client(client) on delete cascade,
  characteristic_name varchar(30) not null,
  description varchar(30) not null,
  data_format varchar(4) not null,
  value_length integer not null default 30,
  decimal_places integer not null default 0,
  unit varchar(6),
  currency varchar(3),
  negative_values_allowed boolean not null default false,
  case_sensitive boolean not null default false,
  intervals_allowed boolean not null default false,
  additional_values_allowed boolean not null default false,
  value_assignment varchar(8) not null default 'SINGLE',
  required_entry boolean not null default false,
  lifecycle_status varchar(8) not null default 'DRAFT',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, characteristic_name),
  constraint characteristic_name_ck check (characteristic_name ~ '^[A-Z0-9_]{1,30}$'),
  constraint characteristic_format_ck check (data_format in ('CHAR', 'NUM', 'DATE', 'TIME', 'CURR')),
  constraint characteristic_length_ck check (value_length > 0),
  constraint characteristic_decimals_ck check (decimal_places >= 0 and decimal_places <= value_length),
  constraint characteristic_intervals_ck check (not intervals_allowed or data_format in ('NUM', 'DATE', 'TIME')),
  constraint characteristic_assignment_ck check (value_assignment in ('SINGLE', 'MULTIPLE')),
  constraint characteristic_lifecycle_ck check (lifecycle_status in ('DRAFT', 'ACTIVE', 'BLOCKED'))
);
--> statement-breakpoint
create table public.characteristic_value (
  client varchar(4) not null references public.client(client) on delete cascade,
  characteristic_name varchar(30) not null,
  value_text varchar(30) not null,
  sort_order integer not null default 0,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, characteristic_name, value_text),
  foreign key (client, characteristic_name)
    references public.characteristic (client, characteristic_name) on delete cascade,
  constraint characteristic_value_sort_ck check (sort_order >= 0)
);
