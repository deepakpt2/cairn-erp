-- 9295_mail_platform.sql
--
-- MAIL-01: mail server configuration (SCOT) and the outbound queue (SOST).
-- One new table, one constraint on an existing table, one capability, one job definition, the
-- registry entry for /platform/mail. No role_capability row: granting CFG.PLT.MAIL.DEFINE is a
-- hand-run administrative act.

create table public.mail_message (
  id               varchar(36) primary key,
  client           varchar(4)  not null references public.client(client) on delete cascade,
  status           varchar(16) not null default 'QUEUED',
  to_address       varchar(200) not null,
  subject          varchar(255) not null,
  body_text        text        not null,
  secret_encrypted text,
  attempts         integer     not null default 0,
  max_attempts     integer     not null default 5,
  available_at     timestamptz not null default now(),
  sent_at          timestamptz,
  last_error       text,
  object_class     varchar(60),
  object_key       varchar(80),
  attachment_name  varchar(200),
  attachment_mime  varchar(100),
  attachment_data  text,
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamptz not null default now(),
  changed_by       varchar(60),
  changed_at       timestamptz,
  constraint mail_message_status_ck check (status in ('QUEUED','SENT','FAILED','DEAD'))
);

alter table public.mail_message enable row level security;
alter table public.mail_message force row level security;

create policy tenant_isolation on public.mail_message
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));

-- Mutable (status, attempts, secret nulling) but never deleted: retention purging is not built.
grant select, insert, update on table public.mail_message to cairn_app;

create index mail_message_claim_idx   on public.mail_message (client, status, available_at);
create index mail_message_created_idx on public.mail_message (client, created_at desc);

-- No check constraint existed on mail_server_config.encryption (verified against pg_constraint).
alter table public.mail_server_config
  add constraint mail_server_config_encryption_ck check (encryption in ('STARTTLS','TLS','NONE'));

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CFG.PLT.MAIL.DEFINE', 'PLT', 'CONFIGURE', false,
   'Configure the outbound mail node (host, port, encryption, credentials, sender), test it, and view the send queue')
on conflict (code) do nothing;

insert into public.job_definition
  (code, name, module, queue, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('MAIL.SEND', 'Send queued mail', 'PLT', 'MAIL', true, '*/5 * * * *', 0, 120, 25, 30)
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9295a000-0000-4000-8000-000000000001', 'CFG.PLT.MAIL.DEFINE', null,
       'Mail server configuration', 'CONFIG_ACTIVITY', 'PLT',
       'Configure the tenant outbound mail node, test the connection, send a test message and read the send queue. '
       || 'The password is write-only. Messages are sent by a scheduled job, never from a request.',
       'TIER_1_BUILT', '/platform/mail', 'B', null, true, 'MIGRATION_9295', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9295a000-0000-4000-8000-000000000001' or r.our_code = 'CFG.PLT.MAIL.DEFINE');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9295b000-0000-4000-8000-000000000001', '9295a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'SCOT', 'SEARCH_ONLY', 'MIGRATION_9295', now()
 where exists (select 1 from public.term_registry r where r.id = '9295a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9295b000-0000-4000-8000-000000000001');

update public.config_activity
   set route_path = '/platform/mail'
 where code = 'CFG.PLT.MAIL.DEFINE' and route_path is distinct from '/platform/mail';
