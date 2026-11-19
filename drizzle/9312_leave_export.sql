-- 9312_leave_export.sql
--
-- Large leave-balance CSV exports, built by the INTENSIVE worker (LEAVE.BALANCE.EXPORT).
-- One row per requested export: who asked, the selection, its lifecycle and the finished CSV.
-- The CSV is stored here (bytea, private, tenant RLS), never on a public or ephemeral path, and only the
-- authorised download reads `body`. A completed export expires `expires_at` (7 days) and is then nulled.

create table if not exists public.leave_export (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  export_id          uuid        not null,
  requester_user_id  varchar(36) not null,
  request_key        varchar(80) not null,
  selection          jsonb       not null,
  job_run_id         varchar(36),
  status             varchar(10) not null default 'QUEUED',
  error_code         varchar(40),
  filename           varchar(80),
  body               bytea,
  row_count          integer,
  byte_length        integer,
  notes              varchar(500),
  created_by         varchar(60) not null,
  created_at         timestamp with time zone not null default now(),
  completed_at       timestamp with time zone,
  expires_at         timestamp with time zone,
  primary key (client, export_id),
  constraint leave_export_status_ck check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED')),
  constraint leave_export_body_ck check ((status = 'COMPLETED') = (body is not null)),
  constraint leave_export_size_ck check (byte_length is null or byte_length between 1 and 52428800)
);
create unique index if not exists leave_export_request_uq on public.leave_export (client, requester_user_id, request_key);
create index if not exists leave_export_requester_idx on public.leave_export (client, requester_user_id, created_at desc);
comment on table public.leave_export is
  'A requested leave-balance CSV too large for the synchronous path. Bound to the requester; the download re-judges the live session, VIEW and EXPORT and the Company Code scope.';

alter table public.leave_export enable row level security;
alter table public.leave_export force row level security;
drop policy if exists tenant_isolation on public.leave_export;
create policy tenant_isolation on public.leave_export
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.leave_export from public;
grant select, insert, update on table public.leave_export to cairn_app;
alter table public.leave_export owner to cairn_integration_migrator;

insert into public.job_definition
  (code, name, module, queue, description, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('LEAVE.BALANCE.EXPORT', 'Leave balance export (large)', 'PEOPLE', 'INTENSIVE',
   'Builds a leave-balance CSV for a large selection in batches, acting as the requesting user (live authority and Company Code scope re-judged). Parameters carry only the export id.',
   false, null, 0, 3600, 1, 30)
on conflict (code) do nothing;
