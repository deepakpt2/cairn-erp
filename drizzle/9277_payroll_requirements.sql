-- 9277_payroll_requirements.sql
--
-- Payroll phase 1: what must stand before a payroll run can be created.
-- Salary structures (SAP pay scale group, T510), their components with the amount
-- rule (FIXED or PERCENT_OF_BASE — the rule lives here, never on pay_component),
-- the employee's assignment to a structure with a base amount (SAP infotype 0008),
-- and the paid/unpaid flag on time types. Nothing here calculates or posts.
--
-- Dates follow the house convention of every dated people table: valid_to is the
-- last day that applies (inclusive), so a span is valid_to >= valid_from.

-- ── Leave without pay becomes identifiable ──────────────────────────────────

alter table public.time_type
  add column if not exists is_paid boolean not null default true;

comment on column public.time_type.is_paid is
  'False for leave without pay. A later payroll phase deducts these days; phase 1 only makes them identifiable.';

-- ── The structure ───────────────────────────────────────────────────────────

create table if not exists public.salary_structure (
  client      varchar(4)  not null references public.client(client) on delete cascade,
  code        varchar(10) not null,
  name        varchar(60) not null,
  currency    varchar(3)  not null,
  valid_from  date not null,
  valid_to    date,
  is_valid    boolean not null default true,
  created_by  varchar(60) not null default 'SYSTEM',
  created_at  timestamp with time zone not null default now(),
  changed_by  varchar(60),
  changed_at  timestamp with time zone,
  primary key (client, code),
  constraint salary_structure_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,9})$'),
  constraint salary_structure_name_length_ck check (length(trim(name)) > 0),
  constraint salary_structure_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
  constraint salary_structure_period_ck check (valid_to is null or valid_to >= valid_from)
);

comment on table public.salary_structure is
  'A named set of pay components (SAP pay scale group, T510). Names what is paid, never a person. Retired by validity, never deleted.';

-- ── One component in one structure, and its amount rule ─────────────────────

create table if not exists public.salary_structure_component (
  client         varchar(4)  not null references public.client(client) on delete cascade,
  structure_code varchar(10) not null,
  component_code varchar(10) not null,
  amount_kind    varchar(20) not null,
  amount_value   numeric(23,4) not null,
  created_by     varchar(60) not null default 'SYSTEM',
  created_at     timestamp with time zone not null default now(),
  changed_by     varchar(60),
  changed_at     timestamp with time zone,
  primary key (client, structure_code, component_code),
  constraint salary_structure_component_kind_ck
    check (amount_kind in ('FIXED','PERCENT_OF_BASE')),
  constraint salary_structure_component_value_ck check (amount_value >= 0),
  constraint salary_structure_component_percent_ck
    check (amount_kind <> 'PERCENT_OF_BASE' or amount_value <= 100),
  constraint salary_structure_component_structure_fk foreign key (client, structure_code)
    references public.salary_structure (client, code) on delete cascade,
  constraint salary_structure_component_component_fk foreign key (client, component_code)
    references public.pay_component (client, code) on delete restrict
);

-- ── What one employee is paid, and from when ────────────────────────────────

create table if not exists public.salary_structure_assignment (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  assignment_id    varchar(36) not null,
  personnel_number varchar(20) not null,
  structure_code   varchar(10) not null,
  base_amount      numeric(23,4) not null,
  currency         varchar(3)  not null,
  valid_from       date not null,
  valid_to         date,
  request_key      varchar(64),
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, assignment_id),
  constraint salary_assignment_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
  constraint salary_assignment_base_ck check (base_amount >= 0),
  constraint salary_assignment_period_ck check (valid_to is null or valid_to >= valid_from),
  constraint salary_assignment_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint salary_assignment_structure_fk foreign key (client, structure_code)
    references public.salary_structure (client, code) on delete restrict
);
create index if not exists salary_assignment_employee_idx
  on public.salary_structure_assignment (client, personnel_number);
create unique index if not exists salary_assignment_request_key_uq
  on public.salary_structure_assignment (client, request_key)
  where request_key is not null;

comment on table public.salary_structure_assignment is
  'An employee''s structure and base amount, effective-dated (SAP infotype 0008). Overlaps are refused by the service; ending one sets valid_to and keeps the row.';

-- ── Row level security and the runtime grants ───────────────────────────────
-- Nothing is deleted by the application: structures and assignments end by validity.
-- A structure component may be changed in place (its amount rule), never removed.

alter table public.salary_structure enable row level security;
alter table public.salary_structure force row level security;
drop policy if exists tenant_isolation on public.salary_structure;
create policy tenant_isolation on public.salary_structure
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.salary_structure from public;
grant select, insert, update on table public.salary_structure to cairn_app;

alter table public.salary_structure_component enable row level security;
alter table public.salary_structure_component force row level security;
drop policy if exists tenant_isolation on public.salary_structure_component;
create policy tenant_isolation on public.salary_structure_component
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.salary_structure_component from public;
grant select, insert, update on table public.salary_structure_component to cairn_app;

alter table public.salary_structure_assignment enable row level security;
alter table public.salary_structure_assignment force row level security;
drop policy if exists tenant_isolation on public.salary_structure_assignment;
create policy tenant_isolation on public.salary_structure_assignment
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.salary_structure_assignment from public;
grant select, insert, update on table public.salary_structure_assignment to cairn_app;

-- ── Capabilities ────────────────────────────────────────────────────────────
-- PEOPLE.PAYROLL.POST already stands (baseline). None of these is granted to any
-- role: payroll authority is withheld deliberately (history/9199).

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.PAYROLLRUN.EXECUTE', 'PEOPLE', 'EXECUTE', false,
   'Create and release a payroll run for one company and period'),
  ('PEOPLE.PAYROLL.RESULT', 'PEOPLE', 'DISPLAY', false,
   'Read the payroll result (the slip) for one employee and period'),
  ('PEOPLE.PAYROLL.IMPORT', 'PEOPLE', 'CREATE', false,
   'Import a payroll result from an external provider'),
  ('PEOPLE.PAYROLL.STRUCTURE.DEFINE', 'PEOPLE', 'DEFINE', false,
   'Define salary structures and their components, and assign employees to them')
on conflict (code) do nothing;

-- ── Registry: route, tier and the names a payroll user searches for ─────────
-- term_registry has no unique key on our_code: every insert is guarded by the
-- fixed id and by the code, so re-running this file adds nothing.

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select v.id, v.our_code, null, v.title, 'TRANSACTION', 'PEOPLE', v.description, 'TIER_1_BUILT', v.route_path,
       'B', v.deferral_note, true, 'MIGRATION_9277', now(), null, null
  from (values
    ('9277a000-0000-4000-8000-000000000001', 'PEOPLE.PAYROLL.STRUCTURE.DEFINE', 'Salary structures',
     'Define salary structures — a named set of pay components with an amount rule each (fixed or a '
     || 'percentage of base) — and assign employees a structure and base amount, effective-dated.',
     '/people/salary-structures', null),
    ('9277a000-0000-4000-8000-000000000002', 'PEOPLE.PAYROLLRUN.EXECUTE', 'Payroll run',
     'Create and release a payroll run for one company and period.',
     null, 'Payroll phase 2: the run and its calculation are not built yet.'),
    ('9277a000-0000-4000-8000-000000000003', 'PEOPLE.PAYROLL.RESULT', 'Payroll result',
     'Read the payroll result (the slip) for one employee and period.',
     null, 'Payroll phase 2: results exist once a run is built.'),
    ('9277a000-0000-4000-8000-000000000004', 'PEOPLE.PAYROLL.IMPORT', 'Import a payroll result',
     'Import a payroll result calculated by an external provider.',
     null, 'A later payroll phase.')
  ) as v(id, our_code, title, description, route_path, deferral_note)
 where not exists (select 1 from public.term_registry r where r.id = v.id or r.our_code = v.our_code);

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, v.term_id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9277', now()
  from (values
    ('9277b000-0000-4000-8000-000000000001', '9277a000-0000-4000-8000-000000000001', 'T510'),
    ('9277b000-0000-4000-8000-000000000002', '9277a000-0000-4000-8000-000000000002', 'PC00_M99_CALC'),
    ('9277b000-0000-4000-8000-000000000003', '9277a000-0000-4000-8000-000000000003', 'PC00_M99_DISPLAY')
  ) as v(id, term_id, alias)
 where exists (select 1 from public.term_registry r where r.id = v.term_id)
   and not exists (select 1 from public.term_alias a where a.id = v.id);
