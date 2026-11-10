-- SCR-117 / R-165 (stage 2): consolidation monitor (CX20)
-- execution history and current task status. UCWB tables remain
-- the configuration authority; these tables never redefine tasks.

create table public.consolidation_execution (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  area varchar(4) not null,
  group_name varchar(24) not null,
  unit varchar(10),
  unit_scope varchar(10) not null default '',
  version varchar(3) not null,
  fiscal_year integer not null,
  period smallint not null,
  task varchar(16) not null,
  configuration_version varchar(64) not null,
  configuration_snapshot text not null,
  attempt_number integer not null,
  mode varchar(6) not null,
  status varchar(10) not null default 'RUNNING',
  executed_by varchar(60) not null,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  duration_ms integer,
  result_summary text not null default '',
  processed_count integer not null default 0,
  warning_count integer not null default 0,
  error_count integer not null default 0,
  generated_document_refs text not null default '[]',
  created_at timestamp with time zone not null default now(),
  primary key (client, run_id),
  foreign key (client, area)
    references public.consolidation_area (client, area) on delete cascade,
  foreign key (client, area, group_name)
    references public.consolidation_group (client, area, group_name),
  foreign key (client, area, unit)
    references public.consolidation_unit (client, area, unit),
  foreign key (client, area, version)
    references public.consolidation_version (client, area, version),
  foreign key (client, area, version, task)
    references public.consolidation_task (client, area, version, task),
  check (mode in ('TEST', 'UPDATE')),
  check (status in ('RUNNING', 'COMPLETED', 'WARNING', 'ERROR', 'BLOCKED', 'CANCELLED')),
  check (period between 1 and 20),
  check (fiscal_year between 1900 and 2199),
  check (attempt_number >= 1),
  check (processed_count >= 0 and warning_count >= 0 and error_count >= 0),
  check (duration_ms is null or duration_ms >= 0),
  check (unit_scope = coalesce(unit, ''))
);

create unique index consolidation_execution_running_uq
  on public.consolidation_execution
    (client, area, group_name, unit_scope, version, fiscal_year, period, task)
  where status = 'RUNNING';

create index consolidation_execution_scope_idx
  on public.consolidation_execution
    (client, area, group_name, version, fiscal_year, period, task, started_at desc);

create table public.consolidation_execution_log (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  sequence integer not null,
  level varchar(8) not null,
  message text not null,
  reference varchar(120),
  created_at timestamp with time zone not null default now(),
  primary key (client, run_id, sequence),
  foreign key (client, run_id)
    references public.consolidation_execution (client, run_id) on delete cascade,
  check (level in ('INFO', 'WARNING', 'ERROR')),
  check (sequence >= 1)
);

create table public.consolidation_task_status (
  client varchar(4) not null references public.client(client) on delete cascade,
  area varchar(4) not null,
  group_name varchar(24) not null,
  unit varchar(10),
  unit_scope varchar(10) not null default '',
  version varchar(3) not null,
  fiscal_year integer not null,
  period smallint not null,
  task varchar(16) not null,
  status varchar(10) not null default 'OPEN',
  blocked_reason text not null default '',
  latest_run_id varchar(24),
  last_mode varchar(6),
  executed_by varchar(60),
  executed_at timestamp with time zone,
  duration_ms integer,
  result_summary text not null default '',
  warning_count integer not null default 0,
  error_count integer not null default 0,
  attempt_count integer not null default 0,
  updated_at timestamp with time zone not null default now(),
  primary key (client, area, group_name, unit_scope, version, fiscal_year, period, task),
  foreign key (client, area)
    references public.consolidation_area (client, area) on delete cascade,
  foreign key (client, area, group_name)
    references public.consolidation_group (client, area, group_name),
  foreign key (client, area, unit)
    references public.consolidation_unit (client, area, unit),
  foreign key (client, area, version)
    references public.consolidation_version (client, area, version),
  foreign key (client, area, version, task)
    references public.consolidation_task (client, area, version, task),
  foreign key (client, latest_run_id)
    references public.consolidation_execution (client, run_id),
  check (status in ('OPEN', 'BLOCKED', 'RUNNING', 'COMPLETED', 'WARNING', 'ERROR')),
  check (last_mode is null or last_mode in ('TEST', 'UPDATE')),
  check (period between 1 and 20),
  check (fiscal_year between 1900 and 2199),
  check (warning_count >= 0 and error_count >= 0 and attempt_count >= 0),
  check (duration_ms is null or duration_ms >= 0),
  check (unit_scope = coalesce(unit, ''))
);

create index consolidation_task_status_scope_idx
  on public.consolidation_task_status
    (client, area, group_name, version, fiscal_year, period, status);
