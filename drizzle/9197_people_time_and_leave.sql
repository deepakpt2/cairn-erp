-- 9197_people_time_and_leave.sql
-- CAIRN.md §8.10: time_recording, absence, attendance, leave_quota — Time data (PA2001, PA2002, PA2006)
-- §10.8: PEOPLE.TIME.ENTER (absence and attendance entry, PA30/CAT2), PEOPLE.LEAVE.VIEW (PT50)
-- §15.1: Time — absences, attendances, leave quotas and balances
-- §15.3: country-specific leave law is NOT built here — entitlement is what the tenant configures,
-- and no statutory rule is invented.
--
-- Four tables, each tenant-scoped, each with forced RLS, each append-only in spirit:
--   time_type        — what the tenant calls a kind of time or absence
--   absence          — a dated leave/absence request with a status workflow
--   leave_quota      — the balance an employee holds for one type in one year
--   time_recording   — hours an employee recorded on a day, of one type

-- ── time_type ───────────────────────────────────────────────────────────────
create table public.time_type (
  client          varchar(4)   not null references client(client) on delete cascade,
  code            varchar(10)  not null,
  name            varchar(60)  not null,
  description     varchar(200),
  type_kind       varchar(12)  not null,
  reduces_quota   boolean      not null default false,
  is_valid        boolean      not null default true,
  created_by      varchar(60)  not null,
  changed_by      varchar(60),
  created_at      timestamptz  not null default now(),
  changed_at      timestamptz,
  primary key (client, code),
  constraint time_type_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,9})$'),
  constraint time_type_kind_ck check (type_kind in ('ABSENCE', 'ATTENDANCE', 'OVERTIME')),
  constraint time_type_name_length_ck check (length(trim(name)) > 0)
);

-- ── absence ─────────────────────────────────────────────────────────────────
create table public.absence (
  client           varchar(4)   not null references client(client) on delete cascade,
  personnel_number varchar(20)  not null,
  time_type_code   varchar(10)  not null,
  valid_from       date         not null,
  valid_to         date,
  status           varchar(12)  not null default 'REQUESTED',
  reason           varchar(200),
  request_key      varchar(64),
  created_by       varchar(60)  not null,
  changed_by       varchar(60),
  created_at       timestamptz  not null default now(),
  changed_at       timestamptz,
  primary key (client, personnel_number, time_type_code, valid_from),
  constraint absence_emp_fk foreign key (client, personnel_number)
    references employee(client, personnel_number) on delete restrict,
  constraint absence_type_fk foreign key (client, time_type_code)
    references time_type(client, code) on delete restrict,
  constraint absence_span_ck check (valid_to is null or valid_to >= valid_from),
  constraint absence_status_ck check (status in ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'))
);
create unique index absence_request_key_uq on public.absence (client, personnel_number, request_key) where request_key is not null;

-- ── leave_quota ─────────────────────────────────────────────────────────────
create table public.leave_quota (
  client           varchar(4)   not null references client(client) on delete cascade,
  personnel_number varchar(20)  not null,
  time_type_code   varchar(10)  not null,
  year             smallint     not null,
  entitlement      numeric(5,2) not null default 0,
  taken            numeric(5,2) not null default 0,
  remaining        numeric(5,2) not null default 0,
  created_by       varchar(60)  not null,
  changed_by       varchar(60),
  created_at       timestamptz  not null default now(),
  changed_at       timestamptz,
  primary key (client, personnel_number, time_type_code, year),
  constraint leave_quota_emp_fk foreign key (client, personnel_number)
    references employee(client, personnel_number) on delete restrict,

  constraint leave_quota_year_ck check (year > 1900 and year < 2100),
  constraint leave_quota_nonnegative_ck check (entitlement >= 0 and taken >= 0 and remaining >= 0)
);

-- ── time_recording ──────────────────────────────────────────────────────────
create table public.time_recording (
  client           varchar(4)   not null references client(client) on delete cascade,
  personnel_number varchar(20)  not null,
  time_type_code   varchar(10)  not null,
  recording_date   date         not null,
  hours            numeric(5,2) not null,
  created_by       varchar(60)  not null,
  changed_by       varchar(60),
  created_at       timestamptz  not null default now(),
  changed_at       timestamptz,
  primary key (client, personnel_number, time_type_code, recording_date),
  constraint time_recording_emp_fk foreign key (client, personnel_number)
    references employee(client, personnel_number) on delete restrict,
  constraint time_recording_type_fk foreign key (client, time_type_code)
    references time_type(client, code) on delete restrict,
  constraint time_recording_hours_ck check (hours > 0 and hours <= 24)
);

-- ── capabilities ────────────────────────────────────────────────────────────
insert into capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.TIME.ENTER', 'PEOPLE', 'ENTER', false,
   'Enter and change an employee''s time and absence: record hours worked, request leave, and keep the balance that the approved absences reduce. Posts nothing — payroll reads the result later.'),
  ('PEOPLE.LEAVE.VIEW', 'PEOPLE', 'VIEW', false,
   'View an employee''s leave quota and balance: entitlement, taken, remaining, for one type in one year. Posts nothing.')
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- ── who may use it ─────────────────────────────────────────────────────────
insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'PEOPLE.TIME.ENTER', 'MIGRATION_9197'
  from role_capability rc
 where rc.capability_code in ('PEOPLE.EMPLOYEE.CREATE', 'PEOPLE.ASSIGNMENT.MAINTAIN')
on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'PEOPLE.LEAVE.VIEW', 'MIGRATION_9197'
  from role_capability rc
 where rc.capability_code in ('PEOPLE.EMPLOYEE.CREATE', 'PEOPLE.ASSIGNMENT.MAINTAIN')
on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'PEOPLE.TIME.ENTER', 'MIGRATION_9197'
  from role_capability rc
 where rc.capability_code = 'CFG.PEOPLE.RECORDTYPE.DEFINE'
on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'PEOPLE.LEAVE.VIEW', 'MIGRATION_9197'
  from role_capability rc
 where rc.capability_code = 'CFG.PEOPLE.RECORDTYPE.DEFINE'
on conflict (client, role_code, capability_code) do nothing;

-- ── registry ────────────────────────────────────────────────────────────────
insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values
  (gen_random_uuid()::text, 'PEOPLE.TIME.ENTER', 'absence', 'Enter time and absence',
   'TRANSACTION', 'PEOPLE',
   'Record hours an employee worked on a day, and request, approve or reject an absence. '
   || 'Each type is defined by the tenant; an absence that reduces a quota lowers the balance '
   || 'the day it is approved. Nothing here posts to the general ledger.',
   'TIER_1_BUILT', '/people/time-leave', 'B', 'MIGRATION_9197'),
  (gen_random_uuid()::text, 'PEOPLE.LEAVE.VIEW', 'leave_quota', 'Leave quota and balance',
   'TRANSACTION', 'PEOPLE',
   'Show an employee''s leave entitlement, taken days and remaining balance for one type in '
   || 'one year, read back from the approved absences that produced it.',
   'TIER_1_BUILT', '/people/time-leave', 'B', 'MIGRATION_9197')
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9197',
  changed_at = now();

-- ── row-level security ─────────────────────────────────────────────────────
do $$
begin
  alter table public.time_type enable row level security;
  alter table public.time_type force row level security;
  drop policy if exists tenant_isolation on public.time_type;
  create policy tenant_isolation on public.time_type
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));

  alter table public.absence enable row level security;
  alter table public.absence force row level security;
  drop policy if exists tenant_isolation on public.absence;
  create policy tenant_isolation on public.absence
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));

  alter table public.leave_quota enable row level security;
  alter table public.leave_quota force row level security;
  drop policy if exists tenant_isolation on public.leave_quota;
  create policy tenant_isolation on public.leave_quota
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));

  alter table public.time_recording enable row level security;
  alter table public.time_recording force row level security;
  drop policy if exists tenant_isolation on public.time_recording;
  create policy tenant_isolation on public.time_recording
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
grant select, insert, update on table public.time_type to cairn_app;
grant select, insert, update on table public.absence to cairn_app;
grant select, insert, update on table public.leave_quota to cairn_app;
grant select, insert, update on table public.time_recording to cairn_app;

-- ── config activity ────────────────────────────────────────────────────────
insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
) values
  ('PEOPLE.TIME.ENTER', 'PEOPLE', null, 'Enter time and absence', 'ENTER',
   'PEOPLE.EMPLOYEE.CREATE', 'Record hours worked and request, approve or reject leave.',
   100, 'STANDARD', '/people/time-leave', true, 'MIGRATION_9197')
on conflict (code) do nothing;

insert into config_activity_status (client, activity_code, status, created_by)
select c.client, 'PEOPLE.TIME.ENTER', 'NOT_STARTED', 'MIGRATION_9197'
from client c
on conflict (client, activity_code) do nothing;