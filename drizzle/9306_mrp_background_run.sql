-- 9306_mrp_background_run.sql
--
-- Background plant run (MD01). A background mrp_run is linked to its job run, and the job
-- definition MRP.PLANT.RUN is declared on the INTENSIVE queue, on demand only (not scheduled).

alter table public.mrp_run drop constraint if exists mrp_run_execution_ck;
alter table public.mrp_run
  add constraint mrp_run_execution_ck check (execution_mode in ('FOREGROUND', 'BACKGROUND'));

alter table public.mrp_run
  add column if not exists job_run_id varchar(36);

comment on column public.mrp_run.job_run_id is
  'The job_run that executes a BACKGROUND run. Null for a foreground run.';

insert into public.job_definition
  (code, name, module, queue, description, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('MRP.PLANT.RUN', 'MRP plant run', 'PP', 'INTENSIVE',
   'Background MD01 plant run. Selects the materials, plans them in dependency order and explodes dependent requirements, resumable from the database state.',
   false, null, 0, 43200, 25, 30)
on conflict (code) do nothing;

-- Keep the business run consistent with its job on EVERY path that ends the job in a
-- terminal state: the worker's own failure handling, the orphan reaper, and an administrator
-- cancelling or dead-lettering from the job monitor (which runs in the web app, where no handler
-- is loaded). Without this, a job ended behind the run's back would leave the run QUEUED or
-- RUNNING, and the plant overlap check would block that plant for ever.
--
-- Work already committed is not undone: planned materials and their proposals stand, only the
-- unplanned ones are marked CANCELLED, and the counts are refreshed so the run says what it did.
create or replace function public.mrp_run_job_ended()
returns trigger
language plpgsql
as $$
declare
  r record;
begin
  if new.job_code <> 'MRP.PLANT.RUN'
     or new.status not in ('FAILED', 'DEAD_LETTER', 'CANCELLED')
     or old.status = new.status then
    return new;
  end if;

  for r in
    select run_number
      from public.mrp_run
     where client = new.client and job_run_id = new.id
       and status in ('QUEUED', 'RUNNING', 'CANCELLING')
     for update
  loop
    update public.mrp_run_material
       set status = 'CANCELLED',
           message = case when new.status = 'CANCELLED'
                          then 'Cancelled before planning.'
                          else 'The run stopped before this material was planned.' end,
           changed_at = now()
     where client = new.client and run_number = r.run_number and status in ('PENDING', 'RUNNING');

    update public.mrp_run m
       set status = case when new.status = 'CANCELLED' then 'CANCELLED' else 'FAILED' end,
           error_summary = case when new.status = 'CANCELLED' then m.error_summary
                                else left(coalesce(nullif(new.error_text, ''), 'The background job failed.'), 200) end,
           materials_selected = c.selected,
           materials_planned = c.planned,
           materials_skipped = c.skipped,
           materials_failed = c.failed,
           proposals_created = p.created,
           proposals_changed = p.changed,
           proposals_retained = p.retained,
           completed_at = now(),
           changed_at = now()
      from (select count(*) filter (where status <> 'PENDING') as selected,
                   count(*) filter (where status = 'COMPLETED') as planned,
                   count(*) filter (where status = 'SKIPPED') as skipped,
                   count(*) filter (where status in ('FAILED', 'CANCELLED')) as failed
              from public.mrp_run_material
             where client = new.client and run_number = r.run_number) c,
           (select count(*) filter (where action = 'CREATE' and status = 'APPLIED') as created,
                   count(*) filter (where action = 'UPDATE' and status = 'APPLIED') as changed,
                   count(*) filter (where action = 'RETAIN') as retained
              from public.mrp_run_proposal
             where client = new.client and run_number = r.run_number) p
     where m.client = new.client and m.run_number = r.run_number;
  end loop;
  return new;
end;
$$;

alter function public.mrp_run_job_ended() owner to cairn_integration_migrator;

drop trigger if exists mrp_run_job_ended_trg on public.job_run;
create trigger mrp_run_job_ended_trg
  after update of status on public.job_run
  for each row execute function public.mrp_run_job_ended();
