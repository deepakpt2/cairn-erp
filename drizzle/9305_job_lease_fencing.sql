-- 9305_job_lease_fencing.sql
--
-- Job leases. A claim now carries an epoch that increases every time the run is
-- claimed or reaped. Anything the worker writes about the run (heartbeat, progress,
-- outcome) and any business write that fences itself is conditional on the epoch it
-- was handed, so a worker that lost its lease (reaped, or paused past the timeout)
-- cannot go on to record or commit work as the owner.

alter table public.job_run
  add column if not exists claim_epoch integer not null default 0;

comment on column public.job_run.claim_epoch is
  'Lease epoch. Incremented by job_claim_next and by the orphan reaper. A worker holds the epoch it was handed at claim time; writes conditional on it fail once the lease is lost.';

-- The return type changes, so the function has to be dropped and recreated.
drop function if exists public.job_claim_next(text, text[]);

create function public.job_claim_next(p_worker_id text, p_queues text[])
returns table (run_id varchar, run_client varchar, run_job_code varchar, run_epoch integer)
language sql
security definer
set search_path = public
as $$
  with candidate as (
    select r.id
      from job_run r
      join job_definition d on d.code = r.job_code
     where r.status in ('QUEUED','BLOCKED')
       and r.next_attempt_at <= now()
       and d.is_enabled
       and (p_queues is null or d.queue = any(p_queues))
     order by r.next_attempt_at, r.queued_at
     for update of r skip locked
     limit 1
  )
  update job_run r
     set status = 'RUNNING',
         worker_id = p_worker_id,
         claimed_at = now(),
         heartbeat_at = now(),
         started_at = coalesce(r.started_at, now()),
         blocked_at = null,
         blocked_on = null,
         claim_epoch = r.claim_epoch + 1
   where r.id = (select id from candidate)
  returning r.id, r.client, r.job_code, r.claim_epoch;
$$;

alter function public.job_claim_next(text, text[]) owner to cairn_integration_migrator;
revoke all on function public.job_claim_next(text, text[]) from public;
grant execute on function public.job_claim_next(text, text[]) to cairn_app;

comment on function public.job_claim_next(text, text[]) is
  'Atomically claim one runnable job across all tenants and return its lease epoch. SECURITY DEFINER owned by the migrator role, because FORCE ROW LEVEL SECURITY on job_run and client otherwise leaves a worker unable to see any tenant but its own. Returns the run id, its tenant, its job code and the epoch only, never parameters or results.';
