-- 9298_totp_mfa.sql
--
-- AUTH-01: two-factor authentication with a code generator (TOTP).
-- Three tables, one capability. No registry row and no alias: /account is registered by 9297 and
-- no reference transaction enrols a TOTP secret. No role_capability row, no job.

create table public.user_mfa (
  client           varchar(4)   not null references public.client(client) on delete cascade,
  user_id          varchar(36)  not null references public.app_user(id) on delete cascade,
  secret_encrypted text         not null,
  status           varchar(12)  not null default 'PENDING',
  enrolled_at      timestamptz,
  confirmed_at     timestamptz,
  last_used_step   bigint,
  last_used_at     timestamptz,
  created_by       varchar(60)  not null default 'SYSTEM',
  created_at       timestamptz  not null default now(),
  changed_by       varchar(60),
  changed_at       timestamptz,
  constraint user_mfa_pkey primary key (client, user_id),
  constraint user_mfa_status_ck check (status in ('PENDING', 'ACTIVE'))
);

create table public.user_mfa_recovery_code (
  id         varchar(36)  primary key,
  client     varchar(4)   not null references public.client(client) on delete cascade,
  user_id    varchar(36)  not null references public.app_user(id) on delete cascade,
  code_hash  varchar(64)  not null,
  used_at    timestamptz,
  created_by varchar(60)  not null default 'SYSTEM',
  created_at timestamptz  not null default now(),
  changed_by varchar(60),
  changed_at timestamptz
);
create index user_mfa_recovery_code_user_idx on public.user_mfa_recovery_code (client, user_id);
create index user_mfa_recovery_code_unused_idx on public.user_mfa_recovery_code (client, user_id, used_at);

create table public.mfa_challenge (
  id           varchar(36)  primary key,
  client       varchar(4)   not null references public.client(client) on delete cascade,
  user_id      varchar(36)  not null references public.app_user(id) on delete cascade,
  expires_at   timestamptz  not null,
  attempts     integer      not null default 0,
  max_attempts integer      not null default 5,
  consumed_at  timestamptz,
  ip_address   varchar(45),
  user_agent   varchar(255),
  created_by   varchar(60)  not null default 'SYSTEM',
  created_at   timestamptz  not null default now(),
  changed_by   varchar(60),
  changed_at   timestamptz
);
create index mfa_challenge_expires_idx on public.mfa_challenge (client, expires_at);
create index mfa_challenge_user_idx on public.mfa_challenge (client, user_id);

alter table public.user_mfa enable row level security;
alter table public.user_mfa force row level security;
alter table public.user_mfa_recovery_code enable row level security;
alter table public.user_mfa_recovery_code force row level security;
alter table public.mfa_challenge enable row level security;
alter table public.mfa_challenge force row level security;

create policy tenant_isolation on public.user_mfa
  using (client = current_setting('cairn.client', true)) with check (client = current_setting('cairn.client', true));
create policy tenant_isolation on public.user_mfa_recovery_code
  using (client = current_setting('cairn.client', true)) with check (client = current_setting('cairn.client', true));
create policy tenant_isolation on public.mfa_challenge
  using (client = current_setting('cairn.client', true)) with check (client = current_setting('cairn.client', true));

-- user_mfa and the recovery codes are deleted by turning two-factor off, by an administrator's reset and by
-- issuing a fresh set of codes; the service exercises DELETE, so it is granted. A challenge is only ever updated.
grant select, insert, update, delete on table public.user_mfa to cairn_app;
grant select, insert, update, delete on table public.user_mfa_recovery_code to cairn_app;
grant select, insert, update on table public.mfa_challenge to cairn_app;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CFG.PLT.USER.MFA.RESET', 'PLT', 'MAINTAIN', false,
   'Reset the two-factor enrolment of a user who has lost their device. Revokes every session of that user')
on conflict (code) do nothing;
