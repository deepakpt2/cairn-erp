-- Central user-administration ACLs must survive both fresh provisioning and
-- in-place credential/role repair. 9000 granted all DML to cairn_app on
-- app_user and user_session; 9186 only narrowed defaults for future tables.
-- 9200 explicitly supplied UPDATE, but role synchronization only created or
-- altered the login and did not reproduce these table grants on an existing
-- volume where ACLs had drifted.
--
-- These three tables are the authentication boundary. Runtime code reads,
-- inserts, and updates users, sessions, and reset-token state. It does not
-- delete from these tables or truncate them. Keep only those required rights.

revoke all privileges on table
  public.app_user,
  public.user_session,
  public.password_reset_token
from cairn_app;

grant select, insert, update on table
  public.app_user,
  public.user_session,
  public.password_reset_token
to cairn_app;

-- Make token scoping consistent with the tenant-scoped account and session
-- tables. The runtime role is not the owner and does not bypass RLS.
alter table public.password_reset_token force row level security;

-- A runtime account must never be able to create objects in the application
-- schema; migrations run as the owning role.
revoke create on schema public from cairn_app;
