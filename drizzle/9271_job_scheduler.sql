-- Job scheduler support — Phase 7
--
-- Phase 4 declared `job_definition.schedule` and `is_scheduled` and nothing
-- ever read them. The scheduler does, and to do that it has to enumerate
-- tenants — which is precisely what the security model forbids.

-- ## Why a definer function is the only way to list tenants
--
-- `client` carries FORCE ROW LEVEL SECURITY and `cairn_app` has no BYPASSRLS,
-- so no application connection can list them. `job_definition` has no `client`
-- column at all: it is platform-wide, while a *run* belongs to a tenant. A
-- scheduled job therefore has to be enqueued once per tenant, and the list of
-- tenants is not available to the process that needs it.
--
-- This is the same answer Phase 4 gave for claiming work, and it is narrow for
-- the same reason: the function returns one column, and everything that happens
-- afterwards — the enqueue, the run itself — goes through the ordinary
-- tenant-scoped path.
create or replace function job_all_clients()
returns table (client varchar)
language sql
security definer
stable
set search_path = public
as $$
  select c.client from client c order by c.client;
$$;

comment on function job_all_clients() is
  'List every tenant key, for the scheduler, which must enqueue scheduled jobs once per tenant. SECURITY DEFINER owned by the migrator role, because FORCE ROW LEVEL SECURITY on client otherwise leaves a worker unable to see any tenant but its own. Returns client codes and nothing else.';

alter function job_all_clients() owner to cairn_integration_migrator;
grant execute on function job_all_clients() to cairn_app;

-- ## The two scheduled jobs Phase 7 introduces
--
-- Definitions are platform-wide, so these are global rows rather than
-- per-tenant configuration. A tenant that does not want one disables it in its
-- own run history, not here; there is no per-tenant switch because nothing has
-- asked for one.

insert into job_definition (code, name, description, queue, module, schedule, is_scheduled, max_retries, timeout_seconds, is_enabled, chunk_size)
values
  (
    'AUTH.GRANT.EXPIRING',
    'Warn before authority expires',
    'Tell each holder that a direct grant of authority ends within the week. Runs once a day; unseen rows are deduplicated, so a grant is mentioned once and not every day until it lapses.',
    'DEFAULT',
    'PEOPLE',
    '17 6 * * *',
    true,
    2,
    600,
    true,
    100
  ),
  (
    'NOTIFY.FANOUT',
    'Resolve who to notify',
    'Resolve every holder of a capability in an organisational scope and write one notification per person. Enqueued in the same transaction as the document change that raised it.',
    'DEFAULT',
    'PEOPLE',
    null,
    false,
    2,
    300,
    true,
    100
  )
on conflict (code) do nothing;
