-- SCR-059 / R-107 (stage 2): release strategies.
--
-- Groups own codes; a strategy binds a group to a classification
-- class and judges a document against its criteria (the delivered
-- attribute catalogue) in priority order; steps sequence the codes
-- that must act. Determination is a service judge; the release acts
-- themselves are the next round.
create table public.release_group (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(12) not null,
  document_category varchar(20) not null,
  description varchar(60) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, group_code),
  constraint release_group_category_ck check (document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER'))
);
--> statement-breakpoint
create table public.release_code (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(12) not null,
  code varchar(8) not null,
  description varchar(60) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, group_code, code),
  foreign key (client, group_code) references public.release_group (client, group_code) on delete cascade
);
--> statement-breakpoint
create table public.release_strategy (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(12) not null,
  strategy_code varchar(12) not null,
  description varchar(60) not null,
  class_type varchar(20) not null,
  class_name varchar(18) not null,
  priority integer not null default 100,
  lifecycle_status varchar(8) not null default 'DRAFT',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, group_code, strategy_code),
  foreign key (client, group_code) references public.release_group (client, group_code) on delete cascade,
  foreign key (client, class_type, class_name)
    references public.classification_class (client, class_type, class_name) on delete cascade,
  constraint release_strategy_priority_ck check (priority > 0),
  constraint release_strategy_lifecycle_ck check (lifecycle_status in ('DRAFT', 'ACTIVE', 'BLOCKED'))
);
--> statement-breakpoint
create table public.release_strategy_criterion (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(12) not null,
  strategy_code varchar(12) not null,
  characteristic_name varchar(30) not null,
  operator varchar(8) not null,
  value_from varchar(30) not null,
  value_to varchar(30),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, group_code, strategy_code, characteristic_name),
  foreign key (client, group_code, strategy_code)
    references public.release_strategy (client, group_code, strategy_code) on delete cascade,
  foreign key (client, characteristic_name)
    references public.characteristic (client, characteristic_name) on delete cascade,
  constraint release_criterion_operator_ck check (operator in ('EQ', 'GE', 'GT', 'LE', 'LT', 'BETWEEN'))
);
--> statement-breakpoint
create table public.release_strategy_step (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(12) not null,
  strategy_code varchar(12) not null,
  step smallint not null,
  release_code varchar(8) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, group_code, strategy_code, step),
  unique (client, group_code, strategy_code, release_code),
  foreign key (client, group_code, strategy_code)
    references public.release_strategy (client, group_code, strategy_code) on delete cascade,
  foreign key (client, group_code, release_code)
    references public.release_code (client, group_code, code) on delete cascade,
  constraint release_step_ck check (step > 0)
);
