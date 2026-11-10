-- SCR-105 / R-153 (stage 2): credit determinations — the single
-- authoritative credit status per sales document (the package's
-- sanctioned fallback until the SD canon lands; future sales
-- documents bind by key). Determinations supersede, never edit;
-- every action lands in the append-only event trail.
create table public.credit_determination (
  client varchar(4) not null references public.client(client) on delete cascade,
  determination_id varchar(24) not null,
  sales_document varchar(20) not null,
  document_date date not null,
  sales_org varchar(4),
  customer varchar(40) not null,
  credit_control_area varchar(4) not null,
  order_value numeric(23, 4) not null,
  order_currency char(3) not null,
  status varchar(16) not null,
  reason varchar(24) not null,
  exposure_at_check numeric(23, 4) not null default 0,
  limit_at_check numeric(23, 4),
  released_by varchar(60),
  released_at timestamp with time zone,
  is_override boolean not null default false,
  approval_ref varchar(40),
  supersedes varchar(24),
  version integer not null default 1,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, determination_id),
  foreign key (client, customer)
    references public.business_partner (client, partner_number) on delete cascade,
  foreign key (client, credit_control_area)
    references public.credit_control_area (client, credit_control_area) on delete cascade,
  check (status in ('BLOCKED', 'PASSED', 'RELEASED')),
  check (order_value >= 0),
  check ((status = 'RELEASED') = (released_by is not null and released_at is not null))
);
--> statement-breakpoint
create index credit_determination_scope_idx
  on public.credit_determination (client, credit_control_area, status, document_date, customer);
--> statement-breakpoint
create index credit_determination_document_idx
  on public.credit_determination (client, sales_document, created_at);
--> statement-breakpoint
create table public.credit_release_event (
  client varchar(4) not null references public.client(client) on delete cascade,
  event_id varchar(24) not null,
  determination_id varchar(24) not null,
  sales_document varchar(20) not null,
  event_type varchar(20) not null,
  actor varchar(60) not null,
  reason varchar(240),
  approval_ref varchar(40),
  before_status varchar(16),
  after_status varchar(16),
  created_at timestamp with time zone not null default now(),
  primary key (client, event_id),
  foreign key (client, determination_id)
    references public.credit_determination (client, determination_id) on delete cascade,
  check (event_type in ('CHECK', 'RELEASE', 'OVERRIDE_RELEASE', 'REJECT', 'REBLOCK'))
);
