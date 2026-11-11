-- Job runtime — CAIRN.md §21, D-022.
--
-- The job tables existed without a runtime: three tables and a `npm run worker`
-- script pointing at a file that was never written. This adds the columns and
-- the claim function that make them runnable.
--
-- ## Why a SECURITY DEFINER function is the only way to claim
--
-- `job_run` and `client` both carry FORCE ROW LEVEL SECURITY, and `cairn_app`
-- has no BYPASSRLS. A worker connected as `cairn_app` with a tenant set sees
-- zero rows belonging to any other tenant — and, because `client` is itself
-- RLS-forced, cannot even enumerate the tenants to loop over. The worker is
-- therefore blind to queued work until something lets it look across tenants.
--
-- The options were a privileged worker role, moving the queue out of `job_run`,
-- or a definer function. Only the last keeps the existing security model intact,
-- and it does so with the smallest possible elevated surface:
--
--   * The function is owned by `cairn_integration_migrator`, the one role with
--     BYPASSRLS — so SECURITY DEFINER lets it see every tenant's queue.
--   * It returns three columns: the run id, its tenant, and its job code. It
--     never exposes `parameters`, `result_summary` or `error_text`.
--   * Job *execution* does not use it. Once a run is claimed, the worker works
--     through the ordinary `withTenant` path and is RLS-scoped like any request.
--
-- A definer function owned by the *table owner* would not have worked: FORCE
-- ROW LEVEL SECURITY applies policies to the owner too. Only BYPASSRLS escapes.
--
-- The alternative — a `cairn_worker` role with BYPASSRLS for the whole worker
-- process — was rejected: it would make every worker bug a cross-tenant data
-- leak, and it contradicts `assertApplicationRole`, which exists precisely to
-- refuse elevated roles at runtime.

alter table job_definition
  add column if not exists may_terminate_sessions boolean not null default false,
  add column if not exists grace_period_seconds integer not null default 300,
  add column if not exists chunk_size integer not null default 100,
  add column if not exists retention_days integer not null default 30;

-- Scheduled critical runs only. An ad-hoc job submitted by a user never gets to
-- close someone else's session, however long it has been waiting.
comment on column job_definition.may_terminate_sessions is
  'Scheduled critical runs only: permits revoking a holder''s session to clear an enqueue lock. Never granted to ad-hoc user-submitted jobs.';

comment on column job_definition.grace_period_seconds is
  'How long a scheduled job warns a lock holder before closing their session. Most conflicts resolve during the warning.';

comment on column job_definition.chunk_size is
  'Documents per lock-commit cycle. A job locks per chunk, commits, releases, repeats — never one long lock.';

comment on column job_definition.retention_days is
  'How long a finished run is kept before purging. Applies to terminal statuses only.';

alter table job_run
  add column if not exists idempotency_key varchar(120),
  add column if not exists next_attempt_at timestamp with time zone not null default now(),
  add column if not exists cancel_requested_at timestamp with time zone,
  add column if not exists cursor jsonb,
  add column if not exists chunks_done integer not null default 0,
  add column if not exists chunks_total integer,
  add column if not exists worker_id varchar(80),
  add column if not exists claimed_at timestamp with time zone,
  add column if not exists heartbeat_at timestamp with time zone,
  add column if not exists blocked_at timestamp with time zone,
  add column if not exists blocked_on jsonb,
  add column if not exists warned_at timestamp with time zone,
  add column if not exists dead_lettered_at timestamp with time zone;

comment on column job_run.next_attempt_at is
  'When this run becomes claimable. Equals queued_at for a fresh run; moved forward for backoff, for a lock wait, and for the grace period before a session is closed.';

comment on column job_run.cursor is
  'Where the run stopped, as opaque JSON handed back to the handler on resume. A resumed run restarts from this chunk, never from zero.';

comment on column job_run.blocked_on is
  'The JOB.BLOCKED payload: which documents are held and by whom. Surfaces on the jobs status page.';

comment on column job_run.warned_at is
  'Set when a scheduled job first warns a lock holder. Its grace period is measured from here, so the warning is sent once and the wait happens once.';

-- BLOCKED is a waiting state, not a failure: the run stops, keeps its cursor,
-- and becomes claimable again when next_attempt_at passes. DEAD_LETTER is
-- terminal and distinct from FAILED so that "needs a human" is not mistaken
-- for "tried and did not work".
alter table job_run drop constraint if exists job_run_status_check;
alter table job_run add constraint job_run_status_check
  check (status in ('QUEUED','RUNNING','BLOCKED','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER'));

-- The claim hot path. Partial, because finished runs are the overwhelming
-- majority over time and are never claimed again.
create index if not exists job_run_claimable_idx
  on job_run (next_attempt_at)
  where status in ('QUEUED','BLOCKED');

-- Idempotency: the same key for the same job and tenant yields one run, so a
-- retried submission cannot queue the same work twice.
create unique index if not exists job_run_idempotency_idx
  on job_run (client, job_code, idempotency_key)
  where idempotency_key is not null;

-- Orphan recovery: a worker killed mid-run leaves heartbeat_at stopped.
create index if not exists job_run_heartbeat_idx
  on job_run (heartbeat_at)
  where status = 'RUNNING';

-- The claim. One statement, atomic, and safe for any number of worker
-- containers: SKIP LOCKED means each takes a different row without blocking.
create or replace function job_claim_next(p_worker_id text, p_queues text[])
returns table (run_id varchar, run_client varchar, run_job_code varchar)
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
         blocked_on = null
   where r.id = (select id from candidate)
  returning r.id, r.client, r.job_code;
$$;

alter function job_claim_next(text, text[]) owner to cairn_integration_migrator;
revoke all on function job_claim_next(text, text[]) from public;
grant execute on function job_claim_next(text, text[]) to cairn_app;

comment on function job_claim_next(text, text[]) is
  'Atomically claim one runnable job across all tenants. SECURITY DEFINER owned by the migrator role, because FORCE ROW LEVEL SECURITY on job_run and client otherwise leaves a worker unable to see any tenant but its own. Returns only the run id, its tenant and its job code — never job parameters or results.';

-- Reaping an orphan is the one other thing that has to look across tenants: a
-- worker that died holding a job leaves it RUNNING, and only a process that can
-- see every tenant can notice. Rather than a privileged reaper, this returns
-- just the tenant keys, and each is then reaped through the ordinary scoped
-- path — so the elevated surface stays a list of tenants and nothing more.
create or replace function job_orphan_clients(p_timeout_seconds integer)
returns table (client varchar)
language sql
security definer
set search_path = public
as $$
  select distinct r.client
    from job_run r
   where r.status = 'RUNNING'
     and r.heartbeat_at < now() - (p_timeout_seconds * interval '1 second');
$$;

alter function job_orphan_clients(integer) owner to cairn_integration_migrator;
revoke all on function job_orphan_clients(integer) from public;
grant execute on function job_orphan_clients(integer) to cairn_app;

comment on function job_orphan_clients(integer) is
  'Tenants holding a RUNNING job whose heartbeat has stopped, i.e. orphaned by a killed worker. Returns tenant keys only; reaping itself runs scoped to each tenant.';

comment on column job_run.heartbeat_at is
  'Advanced by the worker while it runs. A RUNNING run whose heartbeat has stopped was orphaned by a killed worker and is reaped back to QUEUED, keeping its cursor so it resumes rather than restarts.';
