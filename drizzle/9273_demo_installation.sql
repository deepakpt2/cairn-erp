-- Demo installation record
--
-- ENABLE_DUMMY_DATA provisioning runs inside the one-shot `migrate` container, in
-- several transactions rather than one, because every document it creates goes
-- through the ordinary domain services and each of those commits for itself. That
-- makes the installation interruptible, so it needs a record of what has happened
-- that survives the process.
--
-- Two tables, and one rule that matters more than either: this record is never
-- believed on its own. A marker that says "installed" is checked against the data
-- it claims to describe, and a marker that says "in progress" is refused rather
-- than continued, because a half-built dataset that looks finished is worse than
-- no dataset at all.
--
-- These tables are global, not tenant-scoped. That is not an oversight: the
-- eligibility census requires that no tenant exist, so a record living in a
-- tenant's own row could not be written before the work, nor read after an
-- interrupted run left the tenant half-created. Global reference tables such as
-- `capability` and `country` are likewise outside the census, and for the same
-- reason — they are not business data.

create table if not exists demo_installation (
  installation_id varchar(36)   not null primary key,
  -- Bumped whenever the shape of the dataset changes, so an installation made by
  -- an older build is recognised as a different thing rather than silently
  -- resumed as if it were this one.
  operation       varchar(40)   not null,
  database_name   varchar(63)   not null,
  status          varchar(20)   not null,
  -- The accounting calendar the dataset was built against, frozen at claim time.
  -- Dates are generated from this, never from the clock at some later restart,
  -- so a resumed run cannot place documents in different periods than the run
  -- that began them.
  timeline        jsonb         not null default '{}'::jsonb,
  -- What the dataset contains: counts by phase, the credential file's name, the
  -- shared-password salt's fingerprint. Never the password itself.
  payload         jsonb         not null default '{}'::jsonb,
  started_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  completed_at    timestamptz,
  constraint demo_installation_status_ck
    check (status in ('RUNNING', 'COMPLETED', 'FAILED'))
);

comment on table demo_installation is
  'One row per dummy-data installation. Written before any business data and verified against it afterwards.';
comment on column demo_installation.operation is
  'The dataset shape this installation belongs to. A different value means a different dataset, not a continuation.';
comment on column demo_installation.database_name is
  'The database the installation was claimed against. A marker found in another database is not this installation.';
comment on column demo_installation.timeline is
  'The frozen accounting calendar: anchor date and the open posting periods. Persisted so a resumed run reuses the dates the first run chose.';
comment on column demo_installation.status is
  'RUNNING while phases remain, COMPLETED once the declared plan is finished, FAILED once a phase has refused.';

-- One installation, ever. Two rows would mean two runs had each decided they were
-- the first, which is exactly what the advisory lock exists to prevent; the
-- database says so too rather than trusting the lock alone.
create unique index if not exists demo_installation_one_uq
  on demo_installation ((true));

create table if not exists demo_installation_phase (
  installation_id varchar(36)   not null
    references demo_installation (installation_id) on delete cascade,
  phase_code      varchar(40)   not null,
  status          varchar(20)   not null,
  attempt         integer       not null default 1,
  detail          jsonb         not null default '{}'::jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  primary key (installation_id, phase_code),
  constraint demo_installation_phase_status_ck
    check (status in ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'))
);

comment on table demo_installation_phase is
  'One row per phase of one installation. A resumed run skips COMPLETED phases and stops at the first that is not.';
comment on column demo_installation_phase.attempt is
  'How many times this phase has been started. A phase that ran, died and ran again is recorded as attempt 2 rather than pretending the first never happened.';
comment on column demo_installation_phase.detail is
  'What the phase produced: record counts by category. Read back to verify the marker against the data.';

-- Runtime grants, and deliberately no DELETE.
--
-- A table created by a migration arrives with only what the schema default gives
-- the runtime role, so the grants it needs are stated here, as the other
-- migrations do. The provisioner reads, inserts and updates its own record; it
-- never removes one. Withholding DELETE is the point: the thing that could make
-- an interrupted installation look clean by erasing the evidence of it must not
-- be able to.
grant select, insert, update on demo_installation to cairn_app;
grant select, insert, update on demo_installation_phase to cairn_app;

-- ## Why the eligibility scan needs a definer function
--
-- The provisioning step connects as `cairn_app`, which is the role it must use:
-- NOSUPERUSER and NOBYPASSRLS, inside row-level security like every other part of
-- the application. That is also exactly why it cannot count the business data in
-- the database by querying the tables directly. Every tenant-owned table carries a
-- policy restricting rows to the session's tenant, and the provisioning step has
-- no tenant yet — by definition, since eligibility requires that none exist. A
-- plain `select exists (...)` therefore returns false for a table holding
-- thousands of rows belonging to somebody else, and the safety check would pass
-- a database that is anything but empty.
--
-- Measured, not supposed: against a database holding one fully configured tenant,
-- a direct scan reported 7 conflicting tables out of 424 and missed the tenant,
-- its users, and every document it owned.
--
-- The function below runs as the migration role, which owns the tables and is
-- exempt from the policies, and answers one narrow question: which tenant-owned
-- tables hold at least one row. It names no values, returns no data, and accepts
-- no table name from the caller — the list it walks comes from the catalogue, so
-- there is nothing to inject and nothing to aim at a table that is not
-- tenant-owned. The precedent is `cairn_list_tenants()`, which exists for the
-- same reason and is shaped the same way.
--
-- The result is the least disclosure that makes the check true: a list of table
-- names. Not counts, not contents, and not the ability to probe a table of the
-- caller's choosing.

create or replace function demo_tenant_table_count()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from (select table_name
            from information_schema.columns
           where table_schema = 'public'
             and column_name = 'client'
           group by table_name) t;
$$;

create or replace function demo_eligibility_conflicts()
returns table (conflicting_table varchar)
language plpgsql
security definer
set search_path = public
as $$
declare
  r            record;
  v_populated  boolean;
begin
  for r in
    select c.table_name
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.column_name = 'client'
     group by c.table_name
     order by c.table_name
  loop
    -- Fail closed. A table whose identifier this scan cannot safely quote is a
    -- table it cannot vouch for, so it is reported as a conflict rather than
    -- skipped; a safety check that quietly ignores what it cannot read is not
    -- one.
    if r.table_name !~ '^[a-z_][a-z0-9_]*$' then
      conflicting_table := r.table_name;
      return next;
      continue;
    end if;

    execute format('select exists (select 1 from public.%I)', r.table_name)
      into v_populated;

    if v_populated then
      conflicting_table := r.table_name;
      return next;
    end if;
  end loop;
end;
$$;

alter function demo_tenant_table_count() owner to cairn_integration_migrator;
alter function demo_eligibility_conflicts() owner to cairn_integration_migrator;

revoke all on function demo_tenant_table_count() from public;
revoke all on function demo_eligibility_conflicts() from public;

-- The runtime role may ask the question. It may not use the elevated right for
-- anything else: neither function takes an argument, so there is no table it can
-- point them at.
grant execute on function demo_tenant_table_count() to cairn_app;
grant execute on function demo_eligibility_conflicts() to cairn_app;

comment on function demo_eligibility_conflicts() is
  'Tenant-owned tables that already hold a row. Exempt from row-level security, because the caller is the provisioning step and has no tenant — which is the state the answer is meant to confirm.';
comment on function demo_tenant_table_count() is
  'How many tenant-owned tables exist. Zero means the catalogue could not be read, which must be treated as a failed survey rather than an empty database.';


