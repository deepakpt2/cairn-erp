-- 9309_audit_period_pack.sql
--
-- ITEM-21: period-close evidence pack for the auditor workspace (AUDIT.PERIOD.EVIDENCE).
--
--  audit_period_pack   one row per requested pack: the request (who, under which audit grant, which company
--                      code / fiscal year / stored posting period), its lifecycle, and the finished ZIP itself.
--                      The ZIP is stored HERE (bytea, private, tenant RLS) - never on a public or ephemeral path.
--                      Reads of the table for status NEVER select `artifact`; only the authorised download does.
--
-- Retention: a COMPLETED pack expires `expires_at` (default 30 days after completion). Cleanup
-- (cleanupExpiredPeriodPacks) nulls the artifact and sets EXPIRED. It never touches audit_access_log.
-- Size caps (enforced by the generator AND by a check constraint here): ZIP <= 25 MiB.
--
-- The job (job_run) carries only the pack id. Status of the pack follows the job on EVERY end path
-- (worker, orphan reaper, administrator in the job monitor) through the trigger at the end of this file.

create table if not exists public.audit_period_pack (
  client              varchar(4)  not null references public.client(client) on delete cascade,
  pack_id             uuid        not null,
  requester_user_id   varchar(36) not null,
  requester_username  varchar(60) not null,
  grant_id            varchar(36) not null,
  company_code        varchar(10) not null,
  fiscal_year         integer     not null,
  posting_period      integer     not null,
  request_key         varchar(80) not null,
  job_run_id          varchar(36),
  status              varchar(12) not null default 'QUEUED',
  progress_label      varchar(80),
  error_code          varchar(40),
  created_by          varchar(60) not null,
  created_at          timestamp with time zone not null default now(),
  snapshot_at         timestamp with time zone,
  completed_at        timestamp with time zone,
  expires_at          timestamp with time zone,
  artifact            bytea,
  byte_length         integer,
  manifest_sha256     char(64),
  changed_by          varchar(60),
  changed_at          timestamp with time zone,
  primary key (client, pack_id),
  constraint audit_period_pack_grant_fk foreign key (client, grant_id)
    references public.audit_grant (client, grant_id),
  constraint audit_period_pack_status_ck
    check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  constraint audit_period_pack_period_ck check (posting_period between 0 and 16 and fiscal_year between 1900 and 9999),
  constraint audit_period_pack_artifact_ck
    check ((status = 'COMPLETED') = (artifact is not null)),
  constraint audit_period_pack_complete_ck
    check (status <> 'COMPLETED' or (byte_length is not null and manifest_sha256 is not null
                                     and completed_at is not null and expires_at is not null and snapshot_at is not null)),
  constraint audit_period_pack_size_ck check (byte_length is null or byte_length between 1 and 26214400),
  constraint audit_period_pack_hash_ck check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$')
);
create unique index if not exists audit_period_pack_request_uq
  on public.audit_period_pack (client, requester_user_id, request_key);
create index if not exists audit_period_pack_requester_idx
  on public.audit_period_pack (client, requester_user_id, created_at desc);
create index if not exists audit_period_pack_job_idx
  on public.audit_period_pack (client, job_run_id) where job_run_id is not null;
create index if not exists audit_period_pack_expiry_idx
  on public.audit_period_pack (client, expires_at) where artifact is not null;
comment on table public.audit_period_pack is
  'A requested period-close evidence pack (ZIP of CSVs + manifest) for one company code, fiscal year and stored posting period. Bound to the requester and the audit grant it was requested under. The job carries only pack_id.';
comment on column public.audit_period_pack.artifact is
  'The ZIP bytes. Served only by the authorised download (requester + live original grant + capabilities); nulled on expiry.';

alter table public.audit_period_pack enable row level security;
alter table public.audit_period_pack force row level security;
drop policy if exists tenant_isolation on public.audit_period_pack;
create policy tenant_isolation on public.audit_period_pack
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.audit_period_pack from public;
grant select, insert, update on table public.audit_period_pack to cairn_app;
alter table public.audit_period_pack owner to cairn_integration_migrator;

-- The new display capability. Not posting-relevant; deliberately NOT assigned to any role here.
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('AUDIT.PERIOD.EVIDENCE', 'AUDIT', 'DISPLAY', false,
   'Request and read a period-specific, read-only close evidence pack (posting-period rules, recorded changes, closing tasks, journal postings) in the auditor workspace; downloading also needs AUDIT.EVIDENCE.EXPORT')
on conflict (code) do nothing;

insert into public.job_definition
  (code, name, module, queue, description, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('AUDIT.PERIOD.PACK', 'Audit period-close evidence pack', 'AUDIT', 'INTENSIVE',
   'Builds one period-close evidence pack (repeatable-read snapshot, ZIP of CSVs and a hash manifest) for an auditor under a live audit grant, revalidating the submitter and the grant. Parameters carry only the pack id.',
   false, null, 1, 3600, 1, 30)
on conflict (code) do nothing;

-- The pack ends with its job on every path that does not go through the handler: the orphan reaper,
-- an administrator cancelling or dead-lettering in the job monitor. A retried job never resumes a pack
-- that already ended (the handler refuses it), so a generic retry cannot bypass the grant checks.
create or replace function public.audit_period_pack_job_ended()
returns trigger
language plpgsql
as $$
begin
  if new.job_code <> 'AUDIT.PERIOD.PACK'
     or new.status not in ('FAILED', 'DEAD_LETTER', 'CANCELLED')
     or old.status = new.status then
    return new;
  end if;
  update public.audit_period_pack
     set status = case when new.status = 'CANCELLED' then 'CANCELLED' else 'FAILED' end,
         error_code = coalesce(error_code, case when new.status = 'CANCELLED' then 'CANCELLED' else 'JOB_ENDED' end),
         progress_label = null, changed_by = 'JOB_RUNNER', changed_at = now()
   where client = new.client and job_run_id = new.id and status in ('QUEUED', 'RUNNING');
  return new;
end;
$$;
alter function public.audit_period_pack_job_ended() owner to cairn_integration_migrator;
drop trigger if exists audit_period_pack_job_ended_trg on public.job_run;
create trigger audit_period_pack_job_ended_trg
  after update of status on public.job_run
  for each row execute function public.audit_period_pack_job_ended();
