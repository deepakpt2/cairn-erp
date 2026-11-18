-- 9307_payroll_background.sql
--
-- Background payroll: proposal, recalculation and (separately requested) posting run as jobs on the
-- INTENSIVE queue. payroll_run.status keeps its four values; the in-flight work is a linked operation.
--
--  payroll_run_operation  one row per requested calculation or posting. At most ONE operation per run
--                         is active (QUEUED/RUNNING), enforced by a partial unique index, so a second
--                         propose/recalculate/post/release/cancel cannot race it.
--  payroll_calc_stage     the staged outcome of a calculation (frozen population, one row per employee).
--                         The run's real results are replaced from it in ONE transaction at the end,
--                         so the previous valid proposal is never half-replaced. It holds pay amounts,
--                         so it is payroll data under the tenant policy, never copied to the job tables.

create table if not exists public.payroll_run_operation (
  client            varchar(4)  not null references public.client(client) on delete cascade,
  operation_id      varchar(36) not null,
  run_id            varchar(36) not null,
  kind              varchar(12) not null,
  status            varchar(12) not null default 'QUEUED',
  request_key       varchar(80) not null,
  requested_by      varchar(60) not null,
  requested_by_user varchar(36) not null,
  job_run_id        varchar(36),
  employees_total   integer not null default 0,
  employees_done    integer not null default 0,
  error_code        varchar(32),
  error_text        varchar(400),
  created_at        timestamp with time zone not null default now(),
  started_at        timestamp with time zone,
  finished_at       timestamp with time zone,
  changed_at        timestamp with time zone,
  primary key (client, operation_id),
  constraint payroll_run_operation_run_fk foreign key (client, run_id)
    references public.payroll_run (client, run_id) on delete cascade,
  constraint payroll_run_operation_kind_ck check (kind in ('PROPOSE', 'RECALCULATE', 'POST')),
  constraint payroll_run_operation_status_ck check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  constraint payroll_run_operation_counts_ck check (employees_total >= 0 and employees_done >= 0)
);
create unique index if not exists payroll_run_operation_request_uq
  on public.payroll_run_operation (client, request_key);
create unique index if not exists payroll_run_operation_active_uq
  on public.payroll_run_operation (client, run_id) where status in ('QUEUED', 'RUNNING');
create index if not exists payroll_run_operation_run_idx
  on public.payroll_run_operation (client, run_id, created_at desc);
comment on table public.payroll_run_operation is
  'A requested background payroll calculation or posting for one run. One active operation per run. Not the job (job_run): the job carries only the operation id.';

create table if not exists public.payroll_calc_stage (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  operation_id     varchar(36) not null,
  personnel_number varchar(20) not null,
  outcome          varchar(10) not null default 'PENDING',
  covered_by       varchar(36),
  payload          jsonb,
  primary key (client, operation_id, personnel_number),
  constraint payroll_calc_stage_op_fk foreign key (client, operation_id)
    references public.payroll_run_operation (client, operation_id) on delete cascade,
  constraint payroll_calc_stage_outcome_ck check (outcome in ('PENDING', 'RESULT', 'EXCEPTION', 'COVERED'))
);
comment on table public.payroll_calc_stage is
  'Staged calculation outcome per employee, frozen at the start of an operation. Contains pay amounts; deleted when the operation ends.';

do $$
declare
  t text;
begin
  foreach t in array array['payroll_run_operation', 'payroll_calc_stage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update on table public.payroll_run_operation to cairn_app;
grant select, insert, update, delete on table public.payroll_calc_stage to cairn_app;
alter table public.payroll_run_operation owner to cairn_integration_migrator;
alter table public.payroll_calc_stage owner to cairn_integration_migrator;

insert into public.job_definition
  (code, name, module, queue, description, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('PAYROLL.RUN.CALC', 'Payroll calculation', 'PEOPLE', 'INTENSIVE',
   'Background payroll proposal or recalculation: freezes the employee population, calculates in chunks into a staging area, then replaces the run''s results in one transaction.',
   false, null, 0, 21600, 50, 30),
  ('PAYROLL.RUN.POST', 'Payroll posting', 'PEOPLE', 'INTENSIVE',
   'Background posting of a released payroll run as one balanced journal, all or nothing.',
   false, null, 0, 3600, 1, 30)
on conflict (code) do nothing;

-- When the job ends FAILED or CANCELLED by any path (the worker, the orphan reaper, an administrator in
-- the job monitor) the operation ends with it, and its staged amounts are removed. The run itself is
-- untouched: the previous valid proposal stands, a released run stays released.
create or replace function public.payroll_run_operation_job_ended()
returns trigger
language plpgsql
as $$
begin
  if new.job_code not in ('PAYROLL.RUN.CALC', 'PAYROLL.RUN.POST')
     or new.status not in ('FAILED', 'DEAD_LETTER', 'CANCELLED')
     or old.status = new.status then
    return new;
  end if;
  delete from public.payroll_calc_stage s
   using public.payroll_run_operation o
   where o.client = new.client and o.job_run_id = new.id and o.status in ('QUEUED', 'RUNNING')
     and s.client = o.client and s.operation_id = o.operation_id;
  update public.payroll_run_operation
     set status = case when new.status = 'CANCELLED' then 'CANCELLED' else 'FAILED' end,
         error_code = coalesce(error_code, 'JOB_ENDED'),
         error_text = coalesce(error_text, case when new.status = 'CANCELLED'
                                                then 'The job was cancelled. Check the run before repeating the action.'
                                                else 'The background job failed. Check the run before repeating the action.' end),
         finished_at = now(), changed_at = now()
   where client = new.client and job_run_id = new.id and status in ('QUEUED', 'RUNNING');
  return new;
end;
$$;
alter function public.payroll_run_operation_job_ended() owner to cairn_integration_migrator;
drop trigger if exists payroll_run_operation_job_ended_trg on public.job_run;
create trigger payroll_run_operation_job_ended_trg
  after update of status on public.job_run
  for each row execute function public.payroll_run_operation_job_ended();
