-- 9308_payment_run_background.sql
--
-- Background payment run (F110): proposal and execution as jobs on the INTENSIVE queue.
-- payment_run.status keeps its four values; the in-flight work is a linked operation.
--
--  payment_run_operation   one row per requested proposal or execution. At most ONE active (QUEUED/RUNNING)
--                          per run, enforced by a partial unique index, so regenerate, execute, cancel and a
--                          second execute cannot race each other. The house bank and account the user chose
--                          for an execution are kept HERE (identifiers, not credentials), never in the queue.
--  payment_proposal_stage  the staged proposal. The run's real proposal (and its release) are replaced from
--                          it in ONE transaction, so a reader never sees a half-built proposal and an old
--                          release is never attached to a new one.

create table if not exists public.payment_run_operation (
  client            varchar(4)  not null references public.client(client) on delete cascade,
  operation_id      varchar(36) not null,
  run_date          date        not null,
  run_id            varchar(5)  not null,
  kind              varchar(10) not null,
  status            varchar(12) not null default 'QUEUED',
  request_key       varchar(80) not null,
  requested_by      varchar(60) not null,
  requested_by_user varchar(36) not null,
  house_bank_key    varchar(5),
  bank_account_id   varchar(5),
  job_run_id        varchar(36),
  items_total       integer not null default 0,
  items_done        integer not null default 0,
  error_code        varchar(40),
  error_text        varchar(400),
  created_at        timestamp with time zone not null default now(),
  started_at        timestamp with time zone,
  finished_at       timestamp with time zone,
  changed_at        timestamp with time zone,
  primary key (client, operation_id),
  constraint payment_run_operation_run_fk foreign key (client, run_date, run_id)
    references public.payment_run (client, run_date, run_id) on delete cascade,
  constraint payment_run_operation_kind_ck check (kind in ('PROPOSAL', 'EXECUTE')),
  constraint payment_run_operation_status_ck check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  constraint payment_run_operation_bank_ck check (kind <> 'EXECUTE' or (house_bank_key is not null and bank_account_id is not null))
);
create unique index if not exists payment_run_operation_request_uq
  on public.payment_run_operation (client, request_key);
create unique index if not exists payment_run_operation_active_uq
  on public.payment_run_operation (client, run_date, run_id) where status in ('QUEUED', 'RUNNING');
create index if not exists payment_run_operation_run_idx
  on public.payment_run_operation (client, run_date, run_id, created_at desc);
comment on table public.payment_run_operation is
  'A requested background payment-run proposal or execution. One active operation per run. The job (job_run) carries only the operation id.';

create table if not exists public.payment_proposal_stage (
  client       varchar(4)  not null references public.client(client) on delete cascade,
  operation_id varchar(36) not null,
  item_number  integer     not null,
  state        varchar(8)  not null default 'PENDING',
  payload      jsonb       not null,
  primary key (client, operation_id, item_number),
  constraint payment_proposal_stage_op_fk foreign key (client, operation_id)
    references public.payment_run_operation (client, operation_id) on delete cascade,
  constraint payment_proposal_stage_state_ck check (state in ('PENDING', 'READY'))
);
comment on table public.payment_proposal_stage is
  'Staged proposal items of a running proposal operation (supplier, invoice, amount). Deleted when the operation ends.';

do $$
declare
  t text;
begin
  foreach t in array array['payment_run_operation', 'payment_proposal_stage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update on table public.payment_run_operation to cairn_app;
grant select, insert, update, delete on table public.payment_proposal_stage to cairn_app;
alter table public.payment_run_operation owner to cairn_integration_migrator;
alter table public.payment_proposal_stage owner to cairn_integration_migrator;

insert into public.job_definition
  (code, name, module, queue, description, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('PAYMENT.RUN.PROPOSAL', 'Payment run proposal', 'FI', 'INTENSIVE',
   'Background payment proposal: freezes the open items, prepares them in chunks, then replaces the run''s proposal and restarts its release in one transaction.',
   false, null, 0, 21600, 100, 30),
  ('PAYMENT.RUN.EXECUTE', 'Payment run execution', 'FI', 'INTENSIVE',
   'Background execution of a released payment run: one all-or-nothing transaction that posts the payments and clears the items.',
   false, null, 0, 3600, 1, 30)
on conflict (code) do nothing;

-- The operation ends with its job on EVERY path (worker, orphan reaper, administrator in the job monitor),
-- and the staged proposal is removed. The run, its proposal and its release are untouched: an execution is
-- one transaction, so a job that ended without committing posted nothing.
create or replace function public.payment_run_operation_job_ended()
returns trigger
language plpgsql
as $$
begin
  if new.job_code not in ('PAYMENT.RUN.PROPOSAL', 'PAYMENT.RUN.EXECUTE')
     or new.status not in ('FAILED', 'DEAD_LETTER', 'CANCELLED')
     or old.status = new.status then
    return new;
  end if;
  delete from public.payment_proposal_stage s
   using public.payment_run_operation o
   where o.client = new.client and o.job_run_id = new.id and o.status in ('QUEUED', 'RUNNING')
     and s.client = o.client and s.operation_id = o.operation_id;
  update public.payment_run_operation
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
alter function public.payment_run_operation_job_ended() owner to cairn_integration_migrator;
drop trigger if exists payment_run_operation_job_ended_trg on public.job_run;
create trigger payment_run_operation_job_ended_trg
  after update of status on public.job_run
  for each row execute function public.payment_run_operation_job_ended();
