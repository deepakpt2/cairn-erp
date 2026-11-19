-- 9311_leave_policies.sql
--
-- Configurable leave policies, monthly accrual, an immutable leave ledger and policy-split absences.
--
--  leave_group / leave_group_member       reusable groups of people with DATED membership. A person is in at most
--                                         one group at a time (trigger, advisory-locked), so a group policy is never
--                                         ambiguous. A group is NOT an organisation unit or a position.
--  leave_policy / _version / _line        a policy, its effective-dated versions and the lines (one per time type:
--                                         annual days, accrual mode, optional fallback type). Versions and lines are
--                                         immutable once written (a change is a new version); each version records the
--                                         explicit partial-month choice.
--  leave_policy_assignment                a policy given to a GROUP or directly to ONE PERSON for a dated interval.
--                                         One policy per subject at a time (trigger). A PERSON assignment overrides the
--                                         group's for overlapping dates; the resolver (service) never adds the two.
--  leave_ledger                           the immutable event ledger: OPENING, MONTHLY_ACCRUAL, ANNUAL_GRANT, ADJUSTMENT,
--                                         EXPIRY, ABSENCE_DEBIT, REVERSAL. UNIQUE (client, source_key) makes every
--                                         posting idempotent. UPDATE and DELETE are refused (trigger + no grant).
--  leave_quota                            stays as the balance PROJECTION. For mode POLICY it is written only by the
--                                         ledger trigger below, serialised per quota key; legacy rows stay mode LEGACY
--                                         and are never touched by the accrual engine.
--  absence_allocation                     the durable paid/unpaid split of an approved policy-managed absence: each row
--                                         is a day span charged to one quota (type, year) with the pay flag snapshotted
--                                         at approval. Payroll reads THIS, not the current time_type.is_paid.
--  absence                                gains a stable id, policy_managed, the confirmed unpaid days and a request
--                                         fingerprint. A policy-managed absence must have an explicit end date.
--  leave_accrual_run                      one row per accrual execution (status view and not-processed diagnostics).
--
-- Job definitions: LEAVE.ACCRUAL.RUN (regular worker, hourly, bounded) and LEAVE.ACCRUAL.BACKFILL (INTENSIVE, on demand).
-- Authority: new capabilities are granted to NO role here, except PEOPLE.LEAVE.APPROVE, which is copied to the roles that
-- already hold PEOPLE.TIME.ENTER because approving used to need only that (a deliberate, reviewable migration).

-- ── groups ───────────────────────────────────────────────────────────────────
create table if not exists public.leave_group (
  client      varchar(4)  not null references public.client(client) on delete cascade,
  code        varchar(10) not null,
  name        varchar(60) not null,
  description varchar(200),
  is_valid    boolean     not null default true,
  created_by  varchar(60) not null default 'SYSTEM',
  created_at  timestamp with time zone not null default now(),
  changed_by  varchar(60),
  changed_at  timestamp with time zone,
  primary key (client, code),
  constraint leave_group_code_ck check (code ~ '^[A-Z][A-Z0-9]{1,9}$'),
  constraint leave_group_name_ck check (length(trim(name)) > 0)
);

create table if not exists public.leave_group_member (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  id               varchar(36) not null,
  group_code       varchar(10) not null,
  personnel_number varchar(20) not null,
  valid_from       date        not null,
  valid_to         date,
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, id),
  constraint leave_group_member_group_fk foreign key (client, group_code)
    references public.leave_group (client, code) on delete restrict,
  constraint leave_group_member_emp_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint leave_group_member_span_ck check (valid_to is null or valid_to >= valid_from)
);
create index if not exists leave_group_member_emp_idx on public.leave_group_member (client, personnel_number, valid_from);
create index if not exists leave_group_member_group_idx on public.leave_group_member (client, group_code);

-- ── policies ─────────────────────────────────────────────────────────────────
create table if not exists public.leave_policy (
  client      varchar(4)  not null references public.client(client) on delete cascade,
  code        varchar(10) not null,
  name        varchar(60) not null,
  description varchar(200),
  is_valid    boolean     not null default true,
  created_by  varchar(60) not null default 'SYSTEM',
  created_at  timestamp with time zone not null default now(),
  changed_by  varchar(60),
  changed_at  timestamp with time zone,
  primary key (client, code),
  constraint leave_policy_code_ck check (code ~ '^[A-Z][A-Z0-9]{1,9}$'),
  constraint leave_policy_name_ck check (length(trim(name)) > 0)
);

create table if not exists public.leave_policy_version (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  policy_code        varchar(10) not null,
  version            integer     not null,
  valid_from         date        not null,
  -- The administrator must choose; there is no default (the service refuses a missing choice).
  partial_month_mode varchar(14) not null,
  -- Only what is implemented is allowed: calendar-day counting, expiry at year end (no carry-over).
  day_count_mode     varchar(10) not null default 'CALENDAR',
  year_end_mode      varchar(10) not null default 'EXPIRE',
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  primary key (client, policy_code, version),
  constraint leave_policy_version_policy_fk foreign key (client, policy_code)
    references public.leave_policy (client, code) on delete restrict,
  constraint leave_policy_version_partial_ck check (partial_month_mode in ('PRORATE_DAYS', 'FULL_IF_ANY')),
  constraint leave_policy_version_count_ck check (day_count_mode = 'CALENDAR'),
  constraint leave_policy_version_yearend_ck check (year_end_mode = 'EXPIRE'),
  constraint leave_policy_version_month_start_ck check (extract(day from valid_from) = 1),
  constraint leave_policy_version_number_ck check (version >= 1)
);
create unique index if not exists leave_policy_version_from_uq
  on public.leave_policy_version (client, policy_code, valid_from);

create table if not exists public.leave_policy_line (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  policy_code        varchar(10) not null,
  version            integer     not null,
  time_type_code     varchar(10) not null,
  annual_days        numeric(7,2) not null,
  accrual_mode       varchar(14) not null,
  fallback_type_code varchar(10),
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  primary key (client, policy_code, version, time_type_code),
  constraint leave_policy_line_version_fk foreign key (client, policy_code, version)
    references public.leave_policy_version (client, policy_code, version) on delete restrict,
  constraint leave_policy_line_type_fk foreign key (client, time_type_code)
    references public.time_type (client, code) on delete restrict,
  constraint leave_policy_line_fallback_fk foreign key (client, policy_code, version, fallback_type_code)
    references public.leave_policy_line (client, policy_code, version, time_type_code) on delete restrict,
  constraint leave_policy_line_days_ck check (annual_days >= 0 and annual_days <= 366),
  constraint leave_policy_line_mode_ck check (accrual_mode in ('MONTHLY', 'ANNUAL_UPFRONT')),
  constraint leave_policy_line_nofallback_self_ck check (fallback_type_code is null or fallback_type_code <> time_type_code)
);

create table if not exists public.leave_policy_assignment (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  id               varchar(36) not null,
  subject_kind     varchar(6)  not null,
  group_code       varchar(10),
  personnel_number varchar(20),
  policy_code      varchar(10) not null,
  valid_from       date        not null,
  valid_to         date,
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, id),
  constraint leave_policy_assignment_policy_fk foreign key (client, policy_code)
    references public.leave_policy (client, code) on delete restrict,
  constraint leave_policy_assignment_group_fk foreign key (client, group_code)
    references public.leave_group (client, code) on delete restrict,
  constraint leave_policy_assignment_emp_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint leave_policy_assignment_kind_ck check (
    (subject_kind = 'GROUP' and group_code is not null and personnel_number is null)
    or (subject_kind = 'PERSON' and personnel_number is not null and group_code is null)),
  constraint leave_policy_assignment_span_ck check (valid_to is null or valid_to >= valid_from)
);
create index if not exists leave_policy_assignment_group_idx on public.leave_policy_assignment (client, group_code, valid_from);
create index if not exists leave_policy_assignment_person_idx on public.leave_policy_assignment (client, personnel_number, valid_from);

-- ── overlap guards (advisory-locked, so two sessions cannot both find the interval free) ─────────────────
create or replace function public.leave_group_member_overlap_guard()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.client || '/leave-member/' || new.personnel_number, 0));
  if exists (
    select 1 from public.leave_group_member m
     where m.client = new.client and m.personnel_number = new.personnel_number and m.id <> new.id
       and m.valid_from <= coalesce(new.valid_to, date '9999-12-31')
       and coalesce(m.valid_to, date '9999-12-31') >= new.valid_from
  ) then
    raise exception 'LEAVE_MEMBER_OVERLAP: employee % already belongs to a leave group in that interval', new.personnel_number
      using errcode = '23P01';
  end if;
  return new;
end $$;
drop trigger if exists leave_group_member_overlap_trg on public.leave_group_member;
create trigger leave_group_member_overlap_trg before insert or update on public.leave_group_member
  for each row execute function public.leave_group_member_overlap_guard();

create or replace function public.leave_policy_assignment_overlap_guard()
returns trigger language plpgsql as $$
declare
  subject text := coalesce(new.group_code, new.personnel_number);
begin
  perform pg_advisory_xact_lock(hashtextextended(new.client || '/leave-assign/' || new.subject_kind || '/' || subject, 0));
  if exists (
    select 1 from public.leave_policy_assignment a
     where a.client = new.client and a.subject_kind = new.subject_kind and a.id <> new.id
       and coalesce(a.group_code, a.personnel_number) = subject
       and a.valid_from <= coalesce(new.valid_to, date '9999-12-31')
       and coalesce(a.valid_to, date '9999-12-31') >= new.valid_from
  ) then
    raise exception 'LEAVE_ASSIGNMENT_OVERLAP: % % already has a leave policy in that interval', new.subject_kind, subject
      using errcode = '23P01';
  end if;
  return new;
end $$;
drop trigger if exists leave_policy_assignment_overlap_trg on public.leave_policy_assignment;
create trigger leave_policy_assignment_overlap_trg before insert or update on public.leave_policy_assignment
  for each row execute function public.leave_policy_assignment_overlap_guard();

-- Versions and lines are history once written.
create or replace function public.leave_immutable_guard()
returns trigger language plpgsql as $$
begin
  -- A tenant being destroyed cascades its rows away; that is the only delete allowed.
  if tg_op = 'DELETE' and not exists (select 1 from public.client c where c.client = old.client) then
    return old;
  end if;
  raise exception '% rows are immutable; write a new version, entry or reversal instead', tg_table_name using errcode = '23514';
end $$;
drop trigger if exists leave_policy_version_immutable_trg on public.leave_policy_version;
create trigger leave_policy_version_immutable_trg before update or delete on public.leave_policy_version
  for each row execute function public.leave_immutable_guard();
drop trigger if exists leave_policy_line_immutable_trg on public.leave_policy_line;
create trigger leave_policy_line_immutable_trg before update or delete on public.leave_policy_line
  for each row execute function public.leave_immutable_guard();

-- ── absence additions ─────────────────────────────────────────────────────────
alter table public.absence add column if not exists id varchar(36);
update public.absence set id = gen_random_uuid()::text where id is null;
alter table public.absence alter column id set default gen_random_uuid()::text;
alter table public.absence alter column id set not null;
create unique index if not exists absence_id_uq on public.absence (client, id);
alter table public.absence add column if not exists policy_managed boolean not null default false;
alter table public.absence add column if not exists confirmed_unpaid_days numeric(7,2);
alter table public.absence add column if not exists request_fingerprint varchar(64);
alter table public.absence drop constraint if exists absence_policy_end_ck;
alter table public.absence add constraint absence_policy_end_ck check (not policy_managed or valid_to is not null);

-- ── leave_quota: projection mode ──────────────────────────────────────────────
alter table public.leave_quota add column if not exists mode varchar(6) not null default 'LEGACY';
alter table public.leave_quota drop constraint if exists leave_quota_mode_ck;
alter table public.leave_quota add constraint leave_quota_mode_ck check (mode in ('LEGACY', 'POLICY'));
-- First day policy accrual counts for a converted (legacy → policy) quota; null for a quota born under a policy.
alter table public.leave_quota add column if not exists accrual_from date;
comment on column public.leave_quota.mode is
  'LEGACY: hand-set entitlement, never touched by accrual. POLICY: a projection of leave_ledger, written only by the ledger trigger.';

-- ── ledger ───────────────────────────────────────────────────────────────────
create table if not exists public.leave_ledger (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  id               varchar(36) not null,
  personnel_number varchar(20) not null,
  time_type_code   varchar(10) not null,
  year             integer     not null,
  entry_kind       varchar(16) not null,
  effective_date   date        not null,
  quantity         numeric(9,2) not null,
  policy_code      varchar(10),
  policy_version   integer,
  source_kind      varchar(12) not null,
  source_key       varchar(160) not null,
  absence_id       varchar(36),
  note             varchar(200),
  created_by       varchar(60) not null,
  created_at       timestamp with time zone not null default now(),
  primary key (client, id),
  constraint leave_ledger_emp_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint leave_ledger_type_fk foreign key (client, time_type_code)
    references public.time_type (client, code) on delete restrict,
  constraint leave_ledger_kind_ck check (entry_kind in
    ('OPENING', 'MONTHLY_ACCRUAL', 'ANNUAL_GRANT', 'ADJUSTMENT', 'EXPIRY', 'ABSENCE_DEBIT', 'REVERSAL')),
  constraint leave_ledger_source_ck check (source_kind in ('ACCRUAL', 'CONVERSION', 'ADJUSTMENT', 'ABSENCE', 'YEAR_END')),
  constraint leave_ledger_sign_ck check (quantity <> 0 and (
    (entry_kind in ('OPENING', 'MONTHLY_ACCRUAL', 'ANNUAL_GRANT', 'REVERSAL') and quantity > 0)
    or (entry_kind in ('ABSENCE_DEBIT', 'EXPIRY') and quantity < 0)
    or entry_kind = 'ADJUSTMENT')),
  constraint leave_ledger_year_ck check (year > 1900 and year < 2100)
);
create unique index if not exists leave_ledger_source_uq on public.leave_ledger (client, source_key);
create index if not exists leave_ledger_quota_idx on public.leave_ledger (client, personnel_number, time_type_code, year, effective_date);
create index if not exists leave_ledger_absence_idx on public.leave_ledger (client, absence_id) where absence_id is not null;

drop trigger if exists leave_ledger_immutable_trg on public.leave_ledger;
create trigger leave_ledger_immutable_trg before update or delete on public.leave_ledger
  for each row execute function public.leave_immutable_guard();

-- Guard: a POLICY-mode quota is written only by the ledger trigger (which sets the flag for its own statement).
create or replace function public.leave_quota_policy_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.mode = 'POLICY' and exists (select 1 from public.client c where c.client = old.client) then
      raise exception 'A policy-owned leave quota is a projection of the ledger and cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if coalesce(current_setting('cairn.leave_ledger_write', true), '') <> 'on'
     and (new.mode = 'POLICY' or (tg_op = 'UPDATE' and old.mode = 'POLICY')) then
    raise exception 'A policy-owned leave quota is a projection of the ledger; post a ledger entry (adjustment) instead of editing it'
      using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists leave_quota_policy_guard_trg on public.leave_quota;
create trigger leave_quota_policy_guard_trg before insert or update or delete on public.leave_quota
  for each row execute function public.leave_quota_policy_guard();

-- Every ledger insert refreshes the projection, serialised per quota key so concurrent postings add up.
create or replace function public.leave_ledger_project()
returns trigger language plpgsql as $$
declare
  ent numeric(9,2);
  tak numeric(9,2);
  rem numeric(9,2);
  cur varchar(6);
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.client || '/leave-quota/' || new.personnel_number || '/' || new.time_type_code || '/' || new.year, 0));
  select mode into cur from public.leave_quota
   where client = new.client and personnel_number = new.personnel_number
     and time_type_code = new.time_type_code and year = new.year;
  if cur = 'LEGACY' and coalesce(current_setting('cairn.leave_conversion', true), '') <> 'on' then
    raise exception 'LEAVE_QUOTA_LEGACY: the quota of % / % / % is a legacy balance; convert it before posting ledger entries',
      new.personnel_number, new.time_type_code, new.year using errcode = '23514';
  end if;
  select coalesce(sum(quantity) filter (where entry_kind not in ('ABSENCE_DEBIT', 'REVERSAL')), 0),
         coalesce(-sum(quantity) filter (where entry_kind in ('ABSENCE_DEBIT', 'REVERSAL')), 0),
         coalesce(sum(quantity), 0)
    into ent, tak, rem
    from public.leave_ledger
   where client = new.client and personnel_number = new.personnel_number
     and time_type_code = new.time_type_code and year = new.year;
  perform set_config('cairn.leave_ledger_write', 'on', true);
  insert into public.leave_quota (client, personnel_number, time_type_code, year, entitlement, taken, remaining, mode, created_by)
  values (new.client, new.personnel_number, new.time_type_code, new.year, ent, tak, rem, 'POLICY', new.created_by)
  on conflict (client, personnel_number, time_type_code, year) do update
    set entitlement = excluded.entitlement, taken = excluded.taken, remaining = excluded.remaining,
        mode = 'POLICY', changed_by = new.created_by, changed_at = now();
  perform set_config('cairn.leave_ledger_write', 'off', true);
  return new;
end $$;
drop trigger if exists leave_ledger_project_trg on public.leave_ledger;
create trigger leave_ledger_project_trg after insert on public.leave_ledger
  for each row execute function public.leave_ledger_project();

-- ── allocations ──────────────────────────────────────────────────────────────
create table if not exists public.absence_allocation (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  id                 varchar(36) not null,
  absence_id         varchar(36) not null,
  personnel_number   varchar(20) not null,
  seq                integer     not null,
  alloc_from         date        not null,
  alloc_to           date        not null,
  days               numeric(7,2) not null,
  quota_type_code    varchar(10) not null,
  quota_year         integer     not null,
  is_paid            boolean     not null,
  policy_code        varchar(10) not null,
  policy_version     integer     not null,
  debit_ledger_id    varchar(36) not null,
  created_by         varchar(60) not null,
  created_at         timestamp with time zone not null default now(),
  reversed_at        timestamp with time zone,
  reversed_by        varchar(60),
  primary key (client, id),
  constraint absence_allocation_absence_fk foreign key (client, absence_id)
    references public.absence (client, id) on delete restrict,
  constraint absence_allocation_ledger_fk foreign key (client, debit_ledger_id)
    references public.leave_ledger (client, id) on delete restrict,
  constraint absence_allocation_span_ck check (alloc_to >= alloc_from and days > 0),
  constraint absence_allocation_year_ck check (extract(year from alloc_from) = quota_year and extract(year from alloc_to) = quota_year)
);
create unique index if not exists absence_allocation_seq_uq on public.absence_allocation (client, absence_id, seq);
create index if not exists absence_allocation_pay_idx
  on public.absence_allocation (client, personnel_number, alloc_from, alloc_to) where is_paid = false and reversed_at is null;

-- ── accrual run log ──────────────────────────────────────────────────────────
create table if not exists public.leave_accrual_run (
  client         varchar(4)  not null references public.client(client) on delete cascade,
  id             varchar(36) not null,
  kind           varchar(10) not null,
  status         varchar(10) not null default 'RUNNING',
  job_run_id     varchar(36),
  requested_by   varchar(60) not null,
  through_date   date,
  employees_done integer not null default 0,
  entries_posted integer not null default 0,
  exceptions     integer not null default 0,
  detail         jsonb,
  started_at     timestamp with time zone not null default now(),
  finished_at    timestamp with time zone,
  primary key (client, id),
  constraint leave_accrual_run_kind_ck check (kind in ('SCHEDULED', 'MANUAL', 'BACKFILL')),
  constraint leave_accrual_run_status_ck check (status in ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL'))
);
create index if not exists leave_accrual_run_started_idx on public.leave_accrual_run (client, started_at desc);

-- ── RLS, grants, ownership ───────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'leave_group', 'leave_group_member', 'leave_policy', 'leave_policy_version', 'leave_policy_line',
    'leave_policy_assignment', 'leave_ledger', 'absence_allocation', 'leave_accrual_run'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
    execute format('alter table public.%I owner to cairn_integration_migrator', t);
  end loop;
end $$;

grant select, insert, update on table public.leave_group to cairn_app;
grant select, insert, update, delete on table public.leave_group_member to cairn_app;
grant select, insert, update on table public.leave_policy to cairn_app;
grant select, insert on table public.leave_policy_version to cairn_app;
grant select, insert on table public.leave_policy_line to cairn_app;
grant select, insert, update, delete on table public.leave_policy_assignment to cairn_app;
grant select, insert on table public.leave_ledger to cairn_app;
grant select, insert on table public.absence_allocation to cairn_app;
grant update (reversed_at, reversed_by) on table public.absence_allocation to cairn_app;
grant select, insert, update on table public.leave_accrual_run to cairn_app;
alter function public.leave_group_member_overlap_guard() owner to cairn_integration_migrator;
alter function public.leave_policy_assignment_overlap_guard() owner to cairn_integration_migrator;
alter function public.leave_immutable_guard() owner to cairn_integration_migrator;
alter function public.leave_quota_policy_guard() owner to cairn_integration_migrator;
alter function public.leave_ledger_project() owner to cairn_integration_migrator;

-- ── jobs ─────────────────────────────────────────────────────────────────────
insert into public.job_definition
  (code, name, module, queue, description, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('LEAVE.ACCRUAL.RUN', 'Leave accrual (catch-up)', 'PEOPLE', 'DEFAULT',
   'Posts completed-month leave credits that are due, in the tenant''s own time zone, for a bounded recent window. Idempotent: every credit has a unique source key. Older backlog is reported, not processed here.',
   true, '7 * * * *', 2, 1800, 50, 30),
  ('LEAVE.ACCRUAL.BACKFILL', 'Leave accrual (backfill)', 'PEOPLE', 'INTENSIVE',
   'Posts every due completed-month leave credit from each policy assignment start, requested by an authorised user. Same posting rules and keys as the scheduled catch-up.',
   false, null, 0, 21600, 25, 30)
on conflict (code) do nothing;

-- ── authority: copy approve to the roles that approved before (PEOPLE.TIME.ENTER held explicitly) ───────
insert into public.role_capability (client, role_code, capability_code, created_by)
select client, role_code, 'PEOPLE.LEAVE.APPROVE', 'MIGRATION 9311'
  from public.role_capability
 where capability_code = 'PEOPLE.TIME.ENTER'
on conflict do nothing;
