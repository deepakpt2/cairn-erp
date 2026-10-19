-- SCR-101 / R-149 (stage 2): period-end close cockpit structures.
-- Reusable task templates, period-specific task lists/instances,
-- dependency edges, an append-only execution log and an append-only
-- event trail. No existing workflow, job or audit table is reused
-- or duplicated; cycle keys scope everything to tenant + company +
-- fiscal year + posting period.
create table public.closing_task_template (
  client varchar(4) not null references public.client(client) on delete cascade,
  template_code varchar(30) not null,
  task_id varchar(30) not null,
  task_name varchar(80) not null,
  parent_task_id varchar(30),
  sequence integer not null default 0,
  handler_code varchar(40) not null,
  owner varchar(12),
  critical_path boolean not null default false,
  requires_evidence boolean not null default false,
  requires_signoff boolean not null default false,
  parameters text,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, template_code, task_id),
  foreign key (client, template_code, parent_task_id)
    references public.closing_task_template (client, template_code, task_id) on delete cascade,
  check (handler_code in ('PERIOD_STATUS', 'ACCRUAL_REVERSALS', 'FX_VALUATION', 'MANUAL_CONFIRMATION')),
  check (parent_task_id is null or parent_task_id <> task_id)
);
--> statement-breakpoint
create table public.closing_task_template_dependency (
  client varchar(4) not null references public.client(client) on delete cascade,
  template_code varchar(30) not null,
  task_id varchar(30) not null,
  predecessor_task_id varchar(30) not null,
  primary key (client, template_code, task_id, predecessor_task_id),
  foreign key (client, template_code, task_id)
    references public.closing_task_template (client, template_code, task_id) on delete cascade,
  foreign key (client, template_code, predecessor_task_id)
    references public.closing_task_template (client, template_code, task_id) on delete cascade,
  check (task_id <> predecessor_task_id)
);
--> statement-breakpoint
create table public.closing_task_list (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  task_list_id varchar(30) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  description varchar(80),
  status varchar(12) not null default 'INITIAL',
  template_code varchar(30),
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, company_code, task_list_id, fiscal_year, posting_period),
  check (status in ('INITIAL', 'RELEASED', 'FINALIZED')),
  check (posting_period between 1 and 16)
);
--> statement-breakpoint
create table public.closing_task_instance (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  task_list_id varchar(30) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  task_id varchar(30) not null,
  task_name varchar(80) not null,
  parent_task_id varchar(30),
  sequence integer not null default 0,
  handler_code varchar(40) not null,
  owner varchar(12),
  status varchar(12) not null default 'INITIAL',
  critical_path boolean not null default false,
  requires_evidence boolean not null default false,
  requires_signoff boolean not null default false,
  parameters text,
  evidence_ref varchar(120),
  signed_off_by varchar(60),
  signed_off_at timestamp with time zone,
  due_date date,
  attempt_count integer not null default 0,
  last_executed_at timestamp with time zone,
  last_execution_id varchar(24),
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, company_code, task_list_id, fiscal_year, posting_period, task_id),
  foreign key (client, company_code, task_list_id, fiscal_year, posting_period)
    references public.closing_task_list (client, company_code, task_list_id, fiscal_year, posting_period) on delete cascade,
  foreign key (client, company_code, task_list_id, fiscal_year, posting_period, parent_task_id)
    references public.closing_task_instance (client, company_code, task_list_id, fiscal_year, posting_period, task_id) on delete cascade,
  check (handler_code in ('PERIOD_STATUS', 'ACCRUAL_REVERSALS', 'FX_VALUATION', 'MANUAL_CONFIRMATION')),
  check (status in ('INITIAL', 'RELEASED', 'RUNNING', 'COMPLETED', 'ERROR', 'BLOCKED')),
  check (parent_task_id is null or parent_task_id <> task_id)
);
--> statement-breakpoint
create table public.closing_task_dependency (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  task_list_id varchar(30) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  task_id varchar(30) not null,
  predecessor_task_id varchar(30) not null,
  primary key (client, company_code, task_list_id, fiscal_year, posting_period, task_id, predecessor_task_id),
  foreign key (client, company_code, task_list_id, fiscal_year, posting_period, task_id)
    references public.closing_task_instance (client, company_code, task_list_id, fiscal_year, posting_period, task_id) on delete cascade,
  foreign key (client, company_code, task_list_id, fiscal_year, posting_period, predecessor_task_id)
    references public.closing_task_instance (client, company_code, task_list_id, fiscal_year, posting_period, task_id) on delete cascade,
  check (task_id <> predecessor_task_id)
);
--> statement-breakpoint
create table public.closing_execution_log (
  client varchar(4) not null references public.client(client) on delete cascade,
  execution_id varchar(24) not null,
  company_code varchar(10) not null,
  task_list_id varchar(30) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  task_id varchar(30) not null,
  attempt integer not null,
  mode varchar(12) not null,
  status varchar(12) not null,
  initiated_by varchar(60) not null,
  started_at timestamp with time zone,
  ended_at timestamp with time zone,
  result_summary varchar(240),
  error_details text,
  generated_document_number varchar(40),
  generated_fiscal_year integer,
  created_at timestamp with time zone not null default now(),
  primary key (client, execution_id),
  foreign key (client, company_code, task_list_id, fiscal_year, posting_period, task_id)
    references public.closing_task_instance (client, company_code, task_list_id, fiscal_year, posting_period, task_id) on delete cascade,
  check (mode in ('FOREGROUND', 'BACKGROUND')),
  check (status in ('SCHEDULED', 'RUNNING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
create index closing_execution_log_task_idx
  on public.closing_execution_log (client, company_code, task_list_id, fiscal_year, posting_period, task_id, created_at);
--> statement-breakpoint
create table public.closing_task_event (
  client varchar(4) not null references public.client(client) on delete cascade,
  event_id varchar(24) not null,
  company_code varchar(10) not null,
  task_list_id varchar(30) not null,
  fiscal_year integer not null,
  posting_period integer not null,
  task_id varchar(30),
  event_type varchar(20) not null,
  actor varchar(60) not null,
  reason varchar(240),
  detail varchar(240),
  created_at timestamp with time zone not null default now(),
  primary key (client, event_id),
  foreign key (client, company_code, task_list_id, fiscal_year, posting_period)
    references public.closing_task_list (client, company_code, task_list_id, fiscal_year, posting_period) on delete cascade,
  check (event_type in ('CREATED', 'RELEASED', 'EXECUTED', 'RETRIED', 'OVERRIDE', 'SIGNOFF', 'EVIDENCE', 'FINALIZED', 'REOPENED'))
);
