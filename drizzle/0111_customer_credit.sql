-- SCR-103 / R-151 (stage 2): customer credit management.
-- One credit record per customer and credit control area on the
-- canonical partner/area masters, four judged configuration
-- vocabularies, and an append-only field-level change audit.
-- Keys are immutable: no in-place customer/area edits.
create table public.credit_risk_category (
  client varchar(4) not null references public.client(client) on delete cascade,
  risk_category varchar(3) not null,
  name varchar(80) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, risk_category)
);
--> statement-breakpoint
create table public.credit_representative_group (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(3) not null,
  name varchar(80) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, group_code)
);
--> statement-breakpoint
create table public.customer_credit_group (
  client varchar(4) not null references public.client(client) on delete cascade,
  group_code varchar(4) not null,
  name varchar(80) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, group_code)
);
--> statement-breakpoint
create table public.credit_block_reason (
  client varchar(4) not null references public.client(client) on delete cascade,
  reason_code varchar(2) not null,
  name varchar(80) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, reason_code)
);
--> statement-breakpoint
create table public.customer_credit (
  client varchar(4) not null references public.client(client) on delete cascade,
  customer varchar(40) not null,
  credit_control_area varchar(4) not null,
  credit_limit numeric(23, 4) not null,
  credit_currency char(3) not null,
  risk_category varchar(3) not null,
  credit_representative_group varchar(3),
  credit_limit_valid_to date,
  customer_credit_group varchar(4),
  is_blocked boolean not null default false,
  block_reason varchar(2),
  version integer not null default 1,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, customer, credit_control_area),
  foreign key (client, customer)
    references public.business_partner (client, partner_number) on delete cascade,
  foreign key (client, credit_control_area)
    references public.credit_control_area (client, credit_control_area) on delete cascade,
  foreign key (client, risk_category)
    references public.credit_risk_category (client, risk_category),
  foreign key (client, credit_representative_group)
    references public.credit_representative_group (client, group_code),
  foreign key (client, customer_credit_group)
    references public.customer_credit_group (client, group_code),
  check (credit_limit >= 0),
  check ((is_blocked and block_reason is not null) or not is_blocked)
);
--> statement-breakpoint
create table public.credit_change_audit (
  client varchar(4) not null references public.client(client) on delete cascade,
  audit_id varchar(24) not null,
  customer varchar(40) not null,
  credit_control_area varchar(4) not null,
  field varchar(40) not null,
  previous_value varchar(120),
  new_value varchar(120),
  changed_by varchar(60) not null,
  change_reason varchar(240) not null,
  changed_at timestamp with time zone not null default now(),
  primary key (client, audit_id),
  foreign key (client, customer, credit_control_area)
    references public.customer_credit (client, customer, credit_control_area) on delete cascade
);
--> statement-breakpoint
create index credit_change_audit_record_idx
  on public.credit_change_audit (client, customer, credit_control_area, changed_at);
