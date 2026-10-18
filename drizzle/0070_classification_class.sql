-- SCR-058 / R-106 (stage 2): classes for classification (CL02).
--
-- The class-type catalogue is delivered configuration (house words,
-- seeded per tenant by the service). A class is keyed by type and
-- name — both immutable — with the tenant-language description and
-- the Cairn lifecycle shared with characteristics. Assignments hang
-- characteristics beneath a class at unique positions, each
-- characteristic at most once per class.
create table public.class_type (
  client varchar(4) not null references public.client(client) on delete cascade,
  class_type varchar(20) not null,
  description varchar(60) not null,
  object_category varchar(20) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, class_type),
  constraint class_type_category_ck check (object_category in ('MATERIAL', 'BATCH', 'EQUIPMENT', 'VARIANT', 'PURCHASING', 'GENERAL'))
);
--> statement-breakpoint
create table public.classification_class (
  client varchar(4) not null references public.client(client) on delete cascade,
  class_type varchar(20) not null,
  class_name varchar(18) not null,
  description varchar(40) not null,
  lifecycle_status varchar(8) not null default 'DRAFT',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, class_type, class_name),
  foreign key (client, class_type) references public.class_type (client, class_type) on delete cascade,
  constraint classification_class_name_ck check (class_name ~ '^[A-Z0-9_]{1,18}$'),
  constraint classification_class_lifecycle_ck check (lifecycle_status in ('DRAFT', 'ACTIVE', 'BLOCKED'))
);
--> statement-breakpoint
create table public.class_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  class_type varchar(20) not null,
  class_name varchar(18) not null,
  position smallint not null,
  characteristic_name varchar(30) not null,
  required_for_classification boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, class_type, class_name, position),
  unique (client, class_type, class_name, characteristic_name),
  foreign key (client, class_type, class_name)
    references public.classification_class (client, class_type, class_name) on delete cascade,
  foreign key (client, characteristic_name)
    references public.characteristic (client, characteristic_name) on delete cascade,
  constraint class_assignment_position_ck check (position > 0)
);
--> statement-breakpoint
create index class_assignment_characteristic_idx on public.class_assignment (client, characteristic_name);
