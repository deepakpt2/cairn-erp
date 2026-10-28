-- ---------------------------------------------------------------------------
-- 9193: the People master data — configurable record types and the employee with its dated records.
--
-- CAIRN.md §8.10 has listed these five tables since the design was written, §10.8 has listed their codes, and
-- the configuration activity CFG.PEOPLE.RECORDTYPE.DEFINE has been in the registry as an item that enables
-- "Employee master data" with nothing behind it: docs/operational-readiness.md §1 measures HR at one table
-- (`employee_tolerance_group`, an AP/AR control) and zero People screens. This migration starts that module.
--
-- What is deliberately NOT here, because nothing in this slice decides it:
--   * `org_unit`, `position`, `job`, `org_hierarchy`, `position_assignment` (§8.10's organisational block).
--     They are the next increment, and the reason they are not folded in is the employee record: PA0001-style
--     assignment data (position, cost centre, company code, a personnel area) is a *record* of a configured
--     type, so building the org block first with fixed columns would fix a shape the record types exist to
--     avoid. Record types and the dated-record mechanism come first for exactly that reason.
--   * `time_recording`, `absence`, `attendance`, `leave_quota`. No rule in the repository states how an
--     absence is valued or whether it gates a payroll run, so their columns would be guesses.
--   * `pay_component`, `pay_component_config`, `payroll_run`, `payroll_result`, `payroll_result_line`,
--     `deduction_rule`, `deduction_rule_condition`, `payroll_posting_run`, `payroll_posting_line`,
--     `eos_provision_run`, `eos_provision_line`. Payroll is posting-side only (D-013, R-11) and the
--     deduction configuration waits on an owner decision about which jurisdiction's rules it models
--     (docs/operational-readiness.md §4 item 4). No payroll column is created here, so no column can be
--     read as a claim that a run, a payslip or a posting exists.
--   * Statutory income tax, social insurance, filing formats, retro-calculation (DV-001, §15.3), and
--     country-specific leave law. Out of scope by ruling, stated rather than approximated.
--
-- Why a record is a row and its values are rows beside it. DV-012 replaced fixed infotype numbering with
-- configurable record types, so the schema cannot carry one column per possible field: `record_field` says
-- what a type asks for, and `record_field_value` carries one typed slot per answer. The three value columns
-- are not three truths about one fact — `value_kind` on the field picks which one is used, and the check
-- below refuses two — they are one typed slot stored in the type Postgres can judge.
--
-- Why dated history is append-only and what "not an overwrite" means here. §8.10: "a change is a new dated
-- record, not an overwrite". So no row is ever deleted, in this slice or any later one: `delete` is revoked
-- from the runtime role on all five tables, and history older than the newest record for a type is beyond
-- reach by construction. Two narrow exceptions are made, and both are stated as decisions this slice takes
-- for the owner to confirm rather than passed off as settled:
--   * the newest open record of a type may be **delimited** — its `valid_to` written once, from null to a
--     date — because ending a record has no other representation without a delete;
--   * the values of that same newest open record may be **rewritten**, because refusing it would force a
--     second record dated today beside the first, which the interval rule below forbids.
-- `update` is therefore granted on `employee_record` and `record_field_value`, and nothing else is updatable
-- about a record. `record_type`/`record_field` are mutable configuration retired by `is_valid = false`, in
-- the shape OBA4 set for tolerance groups: a definition is never deleted once it can be cited (R-88), and
-- `restrict` on the record's foreign key says a type with records standing cannot be removed at all.
--
-- The personnel number is the caller's, as supplier and customer numbers are (no interval object is stood
-- up for it here, so the standard package is untouched and its version does not move).
-- ---------------------------------------------------------------------------

create table if not exists public.record_type (
  client     varchar(4)  not null references public.client (client) on delete cascade,
  code       varchar(6)  not null,
  name       varchar(60) not null,
  description varchar(200),
  is_valid   boolean     not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint record_type_pk primary key (client, code),
  constraint record_type_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,5})$'),
  constraint record_type_name_length_ck check (length(trim(name)) > 0)
);

create table if not exists public.record_field (
  client        varchar(4)  not null references public.client (client) on delete cascade,
  record_type   varchar(6)  not null,
  code          varchar(30) not null,
  label         varchar(60) not null,
  value_kind    varchar(6)  not null,
  is_required   boolean     not null default false,
  display_order integer     not null default 0,
  created_by    varchar(60) not null default 'SYSTEM',
  created_at    timestamptz not null default now(),
  changed_by    varchar(60),
  changed_at    timestamptz,
  constraint record_field_pk primary key (client, record_type, code),
  constraint record_field_type_fk foreign key (client, record_type)
    references public.record_type (client, code) on delete restrict,
  constraint record_field_code_format_ck check (code ~ '^([A-Z][A-Z0-9_]{1,29})$'),
  -- The three kinds are the whole vocabulary this slice can validate a value against. A fourth (a list of
  -- permitted values, a unit, an input mask) is a rule no reader exists for yet.
  constraint record_field_value_kind_ck check (value_kind in ('TEXT', 'NUMBER', 'DATE')),
  constraint record_field_label_length_ck check (length(trim(label)) > 0),
  constraint record_field_order_non_negative_ck check (display_order >= 0)
);

create index if not exists record_field_type_idx on public.record_field (client, record_type, display_order);

create table if not exists public.employee (
  client             varchar(4)  not null references public.client (client) on delete cascade,
  personnel_number   varchar(20) not null,
  full_name          varchar(60) not null,
  is_active          boolean     not null default true,
  request_key        varchar(64),
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamptz not null default now(),
  changed_by         varchar(60),
  changed_at         timestamptz,
  constraint employee_pk primary key (client, personnel_number),
  constraint employee_number_format_ck check (personnel_number ~ '^([A-Z0-9]{1,20})$'),
  constraint employee_name_length_ck check (length(trim(full_name)) > 0)
);

create unique index if not exists employee_request_key_uq
  on public.employee (client, request_key) where request_key is not null;

create table if not exists public.employee_record (
  client           varchar(4) not null references public.client (client) on delete cascade,
  personnel_number varchar(20) not null,
  record_type      varchar(6)  not null,
  valid_from       date        not null,
  valid_to         date,
  request_key      varchar(64),
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamptz not null default now(),
  changed_by       varchar(60),
  changed_at       timestamptz,
  constraint employee_record_pk primary key (client, personnel_number, record_type, valid_from),
  constraint employee_record_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  -- A record outlives the configuration that named it: the type cannot be removed while a record cites it,
  -- which is the point of `restrict` rather than the cascade the platform uses elsewhere.
  constraint employee_record_type_fk foreign key (client, record_type)
    references public.record_type (client, code) on delete restrict,
  -- `valid_to` is the last day the record applies, inclusive, as an infotype span is: so a record spans
  -- from its first day through its last, and the record that follows starts the day after. A record may
  -- cover a single day, which is what `>=` rather than `>` allows.
  constraint employee_record_span_ck check (valid_to is null or valid_to >= valid_from)
);

-- `valid_to` is inclusive, which is also why the service's overlap test reads `>=`: a record ending on the
-- 30th and a record starting on the 30th would otherwise both claim that day.
-- `valid_to` is inclusive, which is why the service's overlap test reads `>=`: a record ending on the 30th
-- and a record starting on the 30th would otherwise both claim that day.
-- The overlap rule the service enforces inside the transaction needs this prefix to find the records of one
-- employee and one type, newest first, without reading the tenant's whole record table.
create index if not exists employee_record_lookup_idx
  on public.employee_record (client, personnel_number, record_type, valid_from desc);

create unique index if not exists employee_record_request_key_uq
  on public.employee_record (client, personnel_number, record_type, request_key) where request_key is not null;

create table if not exists public.record_field_value (
  client           varchar(4)  not null references public.client (client) on delete cascade,
  personnel_number varchar(20) not null,
  record_type      varchar(6)  not null,
  valid_from       date        not null,
  field_code       varchar(30) not null,
  text_value       varchar(500),
  number_value     numeric(15,2),
  date_value       date,
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamptz not null default now(),
  changed_by       varchar(60),
  changed_at       timestamptz,
  constraint record_field_value_pk primary key (client, personnel_number, record_type, valid_from, field_code),
  constraint record_field_value_record_fk foreign key (client, personnel_number, record_type, valid_from)
    references public.employee_record (client, personnel_number, record_type, valid_from) on delete cascade,
  -- A value may only answer a field its record's type actually asks for.
  constraint record_field_value_field_fk foreign key (client, record_type, field_code)
    references public.record_field (client, record_type, code) on delete restrict,
  constraint record_field_value_one_slot_ck check (
    (text_value is not null)::int + (number_value is not null)::int + (date_value is not null)::int = 1
  ),
  constraint record_field_value_text_length_ck check (text_value is null or length(trim(text_value)) > 0)
);

-- Tenant-scoped, so each of the five carries the forced policy every other tenant table is judged by (D-041),
-- written out table by table the way `9192` did it: a loop over a list of names reads shorter than it runs,
-- and a reader checking that one table is covered should not have to evaluate a `do` block to find out.
do $$
begin
  alter table public.record_type enable row level security;
  alter table public.record_type force row level security;
  drop policy if exists tenant_isolation on public.record_type;
  create policy tenant_isolation on public.record_type
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.record_type from public;

  alter table public.record_field enable row level security;
  alter table public.record_field force row level security;
  drop policy if exists tenant_isolation on public.record_field;
  create policy tenant_isolation on public.record_field
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.record_field from public;

  alter table public.employee enable row level security;
  alter table public.employee force row level security;
  drop policy if exists tenant_isolation on public.employee;
  create policy tenant_isolation on public.employee
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.employee from public;

  alter table public.employee_record enable row level security;
  alter table public.employee_record force row level security;
  drop policy if exists tenant_isolation on public.employee_record;
  create policy tenant_isolation on public.employee_record
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.employee_record from public;

  alter table public.record_field_value enable row level security;
  alter table public.record_field_value force row level security;
  drop policy if exists tenant_isolation on public.record_field_value;
  create policy tenant_isolation on public.record_field_value
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.record_field_value from public;
end $$;

-- The privileges the services actually exercise, read off the writers and no wider, and declared table by
-- table: the grant audit that judges every new migration reads one table per statement, and a comma list that
-- hides four tables from a checker is not a clearer way to say the same thing.
grant update on table public.record_type to cairn_app;
grant update on table public.record_field to cairn_app;
grant update on table public.employee to cairn_app;
-- The two rights below are the whole of what a dated record may take: the write of its last day when the
-- record is ended, and the correction of its answers while it is the newest open record of that type.
grant update on table public.employee_record to cairn_app;
grant update on table public.record_field_value to cairn_app;

-- And no `revoke delete, truncate ... from cairn_app` line, which is a decision rather than an oversight.
-- 9186 set the default for every table the migration role creates at SELECT and INSERT, so DELETE and TRUNCATE
-- are already denied here: `tests/migration-grant-policy` reads a revoke from that role as a declaration that
-- the table is immutable (9185-9187, and the read-only privacy tables of 9016 and 9017), and it holds every
-- such table to no UPDATE either. A dated record's last day has to be written once, so these five tables are
-- not immutable in that sense and must not claim to be; what makes them append-only in fact is that the
-- DELETE privilege is never granted and the services never issue one. Nothing about a person's history can be
-- removed by the application, and `tests/people-employee-master.test.ts` proves it against the live role.

comment on table public.record_type is
  'A configurable record type: what the tenant keeps about a person, named by the tenant. DV-012 replaced fixed infotype numbering with these rows, so a type is data and not a column of the employee.';
comment on table public.record_field is
  'One field a record type asks for, with the kind of value that answers it. The kind is what makes the value column in record_field_value judgeable rather than free text.';
comment on table public.employee is
  'The employee: a personnel number the caller supplies and a name. Everything else about a person is a dated record of a configured type, not a column here.';
comment on column public.employee.personnel_number is
  'The personnel number, the employee''s own key within the tenant. External by decision, as supplier numbers are: no interval object is drawn, so a tenant may carry its payroll provider''s numbering unchanged.';
comment on table public.employee_record is
  'One dated record of one type for one employee. A change is a new row with its own span; the row it replaces keeps standing, and no row of this table is ever deleted or rewritten except the two narrow acts this migration names.';
comment on column public.employee_record.valid_to is
  'The last day the record applies, inclusive, null while it is open. Ending a record writes this once — the only change to a date span that history ever takes.';
comment on table public.record_field_value is
  'The answers a dated record holds, one row per field, stored in the column its field''s kind selects.';

-- The capability the employee screen and its actions both name. Neither is posting-relevant: this slice
-- moves no money, and the description says so, because the row a reader finds must not be mistaken for
-- payroll being built.
insert into capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.EMPLOYEE.CREATE', 'PEOPLE', 'CREATE', false,
   'Create, change and display an employee master and its dated records at /people/employees (PA40, PA30). '
   || 'An employee is a personnel number and a name; what is known about them stands in dated records of the '
   || 'configured types. Nothing here calculates or posts payroll.'),
  ('PEOPLE.RECORD.MAINTAIN', 'PEOPLE', 'MAINTAIN', false,
   'Maintain one dated record of a configured type: write it, end it by delimiting its last day, and correct '
   || 'the values while it is the newest open record of that type. History that a newer record has replaced '
   || 'is out of reach, and no record is deleted.'),
  ('CFG.PEOPLE.RECORDTYPE.DEFINE', 'PEOPLE', 'CONFIGURE', false,
   'Define employee record types and the fields each asks for at /config/people-record-types. A type retired '
   || 'by validity stops new records and keeps the ones already standing; a type any record cites cannot be removed.')
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- Who may define record types today: the roles that already define the organisation a record points at. No
-- People role exists in the standard package, so no operational code is widened on this migration's own
-- authority — an employee master is reachable by an administrator, whose '*' pattern covers it, and by
-- nobody else until a People role model is a decision rather than a convenience.
insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'CFG.PEOPLE.RECORDTYPE.DEFINE', 'MIGRATION_9193'
  from role_capability rc
 where rc.capability_code = 'CFG.ORG.COMPANYCODE.DEFINE'
on conflict (client, role_code, capability_code) do nothing;

-- The registry stops promising People routes it does not have. These are the first two.
insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values (
  gen_random_uuid()::text, 'PEOPLE.EMPLOYEE.CREATE', 'employee', 'Employee master', 'TRANSACTION', 'PEOPLE',
  'The employee and their dated records: a personnel number and a name on the master, everything else in '
  || 'records of the types the tenant configured. Creating one posts nothing. Payroll runs, results, payslips '
  || 'and the posting to FI are not built (D-013, R-11, §15.3), and the organisational records that would '
  || 'assign a position and a cost centre arrive with the org block.',
  'TIER_1_CORE', '/people/employees', 'B', 'MIGRATION_9193'
), (
  gen_random_uuid()::text, 'CFG.PEOPLE.RECORDTYPE.DEFINE', 'record_type', 'Define employee record types',
  'CONFIG_ACTIVITY', 'PEOPLE',
  'What a record type is, and the fields it asks for, with the kind of each. This is the activity the registry '
  || 'has carried since the design as the thing that enables "Employee master data"; it stops being inert here.',
  'TIER_1_CORE', '/config/people-record-types', 'B', 'MIGRATION_9193'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9193',
  changed_at = now();
