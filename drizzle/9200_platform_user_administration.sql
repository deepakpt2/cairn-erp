-- 9200_platform_user_administration.sql
-- Password reset tokens and user administration structures.
--
-- CAIRN.md §23: application users are independent of employee master records.
-- A user can exist without an employee link; password recovery must work for
-- such users. Reset tokens are single-use, short-lived, tenant-scoped, and
-- stored only as a SHA-256 hash — never plaintext, never reversible.
--
-- SCR-003 User administration (SU01) — DRAFT in CAIRN.md §26.1. This migration
-- adds the database shape; the writer, UI and capability grant are this slice.
-- No email transport exists yet (D-033, mail server not configured), so reset
-- intent is recorded and the token is delivered by the administrator or by the
-- deferred mail transport when it arrives.

create table public.password_reset_token (
  id              varchar(36)      not null primary key,
  client          varchar(4)       not null references public.client (client) on delete cascade,
  user_id         varchar(36)      not null references public.app_user (id) on delete cascade,
  token_hash      varchar(255)     not null,
  expires_at      timestamp with time zone not null,
  used_at         timestamp with time zone,
  created_by      varchar(60)      not null default 'SYSTEM',
  ip_address      varchar(45),
  created_at      timestamp with time zone not null default now()
);

alter table public.password_reset_token enable row level security;

create policy password_reset_token_tenant_isolation
  on public.password_reset_token
  for all
  to public
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));

create index password_reset_token_user_idx on public.password_reset_token (user_id);
create index password_reset_token_expires_idx on public.password_reset_token (expires_at);

-- Grant user administration capabilities to ADMINISTRATOR (holds '*' already,
-- so no row needed — but register explicitly for CONFIGURATOR maintenance use
-- and for the workbench tree).
insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'CFG.PLT.USER.MAINTAIN', 'MIGRATION_9200'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'CFG.PLT.USER.PASSWORD_RESET', 'MIGRATION_9200'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

-- The password_reset_token table is created after migration 9186 revoked
-- UPDATE and DELETE on future tables from cairn_app. The user administration
-- and self-service reset flows need UPDATE on password_reset_token (to consume
-- tokens), app_user (to change passwords and deactivate), and user_session (to
-- revoke sessions). Grant only the minimum UPDATE needed.
grant update on table public.password_reset_token to cairn_app;
grant update on table public.app_user to cairn_app;
grant update on table public.user_session to cairn_app;
