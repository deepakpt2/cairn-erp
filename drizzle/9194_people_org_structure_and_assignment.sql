-- ---------------------------------------------------------------------------
-- 9194: the organisational block — org units, positions, jobs, the structure they stand in, and
-- the assignment that puts an employee into it.
--
-- CAIRN.md §8.10 names these five tables ("org_unit, position, job, org_hierarchy | Organisational
-- structure" and "position_assignment | Position → cost centre → employee assignment"), §15.1 says
-- what the increment is supposed to do — "Org units, positions, jobs, hierarchy, reporting line" and
-- "Assignment | Position → cost centre → employee, with validity dates" — and §10.8 has carried
-- PEOPLE.ORGUNIT.CREATE (PPOCE), PEOPLE.POSITION.CREATE (PPOME) and PEOPLE.ASSIGNMENT.MAINTAIN (PA30)
-- as codes with no table and no screen behind them. This migration gives the three codes their tables.
-- §6.1's define-then-assign graph (D-086: plant before work centre, storage location before bin) is
-- why the masters and the assignment land in one slice: org units and positions with nobody in them
-- would be the same "a registry row promises a route that does not exist" shape this file closes.
--
-- One correction to a note 9193 left behind. It deferred this block on the ground that "PA0001-style
-- assignment data (position, cost centre, company code, a personnel area) is a *record* of a
-- configured type". §8.10 does not list it as one — `position_assignment` is named as its own table
-- with its own purpose — so it is built as its own table. What carries over from 9193 is not the
-- record-type indirection but the *span* mechanics: validity dates, an inclusive `valid_to`, and a
-- change that creates a new dated row instead of overwriting one. The configurable record types
-- remain what they are for: the many things a tenant wants to know about a person that no table names.
--
-- What is deliberately NOT here, and what it would have cost to include it:
--   * Dated org units, positions, jobs, hierarchy edges. §15.1 asks for validity dates on the
--     Assignment and nowhere else; the repository's own answer to the same question for cost centres
--     dates the master's attributes (drizzle/0050) and keeps the tree undated (drizzle/0052). So a
--     misfiled org unit is moved in place, and the structure cannot answer "what did it look like in
--     March". That is a real limitation, recorded rather than designed away: any report that counts
--     people over time has to state that it reads the tree as it stands today.
--   * A leading position (the position that heads an org unit), vacancies, and headcount planning on
--     positions. None of the three appears in §8.10's five words or §15.1's row, and each would have
--     to invent its own rule about what a vacancy permits.
--   * An employee-to-employee reporting line (PA0001's supervisor personnel number). §15.1 lists
--     "reporting line" inside the organisational structure row, beside positions and hierarchy, so the
--     line here joins positions. A line between people is a personnel record of a configured type
--     until someone decides it is not.
--   * An org unit's assignment to a company code, and the cost centre the unit's positions charge to
--     by default. Both are real ERP objects; neither is in this design's rows, and a default that is
--     not asked for is a rule about where money goes.
--   * Splitting one employee's time over several cost centres, and letting one employee hold two
--     assignments at once. §8.10 and §15.1 both read "Position → cost centre → employee" in the
--     singular, and the percentages a split would need are a CO question the repository leaves open.
--     The key below therefore allows one assignment per employee per start date and the service allows
--     no overlap: an employee has exactly one position and one cost centre on any given day.
--   * `pay_component`, `payroll_*`, `eos_*`, `time_recording`, `absence`, `attendance`, `leave_quota`.
--     Unchanged from 9193: payroll is posting-side only (D-013, R-11) and the rules those tables would
--     carry are open decisions, not gaps in this file.
--
-- Rights, and why they differ from 9193's: `delete` is granted on `org_hierarchy` and on nothing else
-- here. An edge of the tree is a fact about structure rather than a person's history, so a position
-- filed under the wrong unit has to be movable, and in a table keyed by its child a move is a delete
-- and an insert. Every other table takes select and insert from the platform defaults plus an explicit
-- `grant update` written one table per statement, and `position_assignment` is like `employee_record`:
-- `valid_to` is the only change history ever accepts and no row of it is deleted. No
-- `revoke delete … from cairn_app` appears in this file, for the reason 9193 recorded — the grant audit
-- in tests/migration-grant-policy reads such a line as a declaration that the table is immutable and
-- then refuses any update on it — and DELETE is denied anyway, by the 9186 defaults, which the tests
-- prove with a live attempt rather than by the comment.
-- ---------------------------------------------------------------------------

create table if not exists public.org_unit (
  client      varchar(4)  not null references public.client (client) on delete cascade,
  code        varchar(10) not null,
  name        varchar(60) not null,
  description varchar(200),
  is_valid    boolean     not null default true,
  created_by  varchar(60) not null default 'SYSTEM',
  created_at  timestamptz not null default now(),
  changed_by  varchar(60),
  changed_at  timestamptz,
  constraint org_unit_pk primary key (client, code),
  constraint org_unit_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,9})$'),
  constraint org_unit_name_length_ck check (length(trim(name)) > 0)
);

create table if not exists public.job (
  client      varchar(4)  not null references public.client (client) on delete cascade,
  code        varchar(10) not null,
  name        varchar(60) not null,
  description varchar(200),
  is_valid    boolean     not null default true,
  created_by  varchar(60) not null default 'SYSTEM',
  created_at  timestamptz not null default now(),
  changed_by  varchar(60),
  changed_at  timestamptz,
  constraint job_pk primary key (client, code),
  constraint job_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,9})$'),
  constraint job_name_length_ck check (length(trim(name)) > 0)
);

create table if not exists public.position (
  client       varchar(4)  not null references public.client (client) on delete cascade,
  code         varchar(10) not null,
  title        varchar(60) not null,
  job_code     varchar(10),
  description  varchar(200),
  is_valid     boolean     not null default true,
  created_by   varchar(60) not null default 'SYSTEM',
  created_at   timestamptz not null default now(),
  changed_by   varchar(60),
  changed_at   timestamptz,
  constraint position_pk primary key (client, code),
  constraint position_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,9})$'),
  constraint position_title_length_ck check (length(trim(title)) > 0),
  -- A job outlives the positions that cite it: it cannot be removed while one stands (the same `restrict`
  -- 9193 chose for a record type that has records), and a position may exist before anyone decides its job.
  constraint position_job_fk foreign key (client, job_code)
    references public.job (client, code) on delete restrict
);

create index if not exists position_job_idx on public.position (client, job_code);

-- One table for both edges the design asks for, because "hierarchy" and "reporting line" are two shapes of
-- the same fact — an object that points at the object above it — and two tables would mean two answers to
-- "what is above this one". `child` is the keyed side, which is what makes the one-parent rule a
-- constraint rather than a convention: the same trick drizzle/0052 played for cost centre nodes, whose
-- unique index on the child is the whole of its one-parent rule while cycles and depth are judged above.
create table if not exists public.org_hierarchy (
  client        varchar(4)  not null references public.client (client) on delete cascade,
  relation_type varchar(12) not null,
  parent_kind   varchar(8)  not null,
  parent_code   varchar(10) not null,
  child_kind    varchar(8)  not null,
  child_code    varchar(10) not null,
  created_by    varchar(60) not null default 'SYSTEM',
  created_at    timestamptz not null default now(),
  changed_by    varchar(60),
  changed_at    timestamptz,
  constraint org_hierarchy_pk primary key (client, relation_type, child_kind, child_code),
  constraint org_hierarchy_relation_ck check (relation_type in ('STRUCTURE', 'REPORTS_TO')),
  constraint org_hierarchy_kind_ck check (
    parent_kind in ('ORGUNIT', 'POSITION') and child_kind in ('ORGUNIT', 'POSITION')
  ),
  -- Which pairs the two relations permit. STRUCTURE is the tree: an org unit under an org unit, or a
  -- position standing in an org unit — so a position's unit is a row here and nowhere else. REPORTS_TO is
  -- the line §15.1 names, and it joins a position to the position above it. Anything else is a relation
  -- this design does not contain: a unit that reports to a position, a position that is a unit's parent.
  constraint org_hierarchy_pairs_ck check (
    (relation_type = 'STRUCTURE' and parent_kind = 'ORGUNIT' and child_kind in ('ORGUNIT', 'POSITION'))
    or (relation_type = 'REPORTS_TO' and parent_kind = 'POSITION' and child_kind = 'POSITION')
  ),
  -- The direct self-loop is a constraint; a loop of two or more is a walk, and the service walks it (see
  -- the depth rule in the note below the tables).
  constraint org_hierarchy_not_self_ck check (parent_kind <> child_kind or parent_code <> child_code)
);

create index if not exists org_hierarchy_parent_idx
  on public.org_hierarchy (client, relation_type, parent_kind, parent_code);

-- The assignment: which position an employee held, whose cost centre carried them, from when to when.
-- It is keyed by the employee and the first day, so "two assignments of one employee beginning the same
-- day" is refused by the primary key and "two assignments of one employee overlapping" is refused by the
-- service — the division 9193 drew between what a key can say and what a span has to say.
create table if not exists public.position_assignment (
  client           varchar(4)  not null references public.client (client) on delete cascade,
  personnel_number varchar(20) not null,
  position_code    varchar(10) not null,
  controlling_area varchar(4)  not null,
  cost_center      varchar(10) not null,
  valid_from       date        not null,
  valid_to         date,
  request_key      varchar(64),
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamptz not null default now(),
  changed_by       varchar(60),
  changed_at       timestamptz,
  constraint position_assignment_pk primary key (client, personnel_number, valid_from),
  -- Both directions of the naming are real keys, not text: the employee is the one 9193 created, and
  -- `restrict` means a position someone has been assigned to cannot be removed underneath them.
  constraint position_assignment_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint position_assignment_position_fk foreign key (client, position_code)
    references public.position (client, code) on delete restrict,
  -- The cost centre is a dated object — its own key is (controlling area, cost centre, valid_from) in
  -- drizzle/0050 — so a dated record cannot point at one interval of it. The controlling area is a real
  -- foreign key and the code keeps to that table's own format; whether the cost centre existed and was
  -- valid across the assignment's span is the service's question, in the same shape the finance lines
  -- ask it (src/modules/finance/schema.ts stores `cost_center` as a code, not a key).
  constraint position_assignment_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area) on delete restrict,
  constraint position_assignment_area_format_ck check (controlling_area ~ '^[A-Z0-9]{4}$'),
  constraint position_assignment_cc_format_ck check (cost_center ~ '^[A-Z0-9]{1,10}$'),
  -- Inclusive last day, exactly as an infotype span and as `employee_record` above: the assignment that
  -- follows starts the day after the one it replaces.
  constraint position_assignment_span_ck check (valid_to is null or valid_to >= valid_from)
);

create unique index if not exists position_assignment_request_key_uq
  on public.position_assignment (client, personnel_number, request_key) where request_key is not null;

-- The two reads this table exists to serve: everything an employee was assigned to, newest first, and
-- everyone standing in one position today for the org screens' incumbent column.
create index if not exists position_assignment_employee_idx
  on public.position_assignment (client, personnel_number, valid_from desc);
create index if not exists position_assignment_position_idx
  on public.position_assignment (client, position_code, valid_from);
create index if not exists position_assignment_cost_center_idx
  on public.position_assignment (client, controlling_area, cost_center, valid_from);

comment on table public.org_unit is 'An organisational unit: a name and a place in a tree. The parent is a row of org_hierarchy, not a column here, so the tree has one answer. A unit is retired by validity rather than deleted, because positions and other units cite it.';
comment on table public.job is 'A job: what a position does, named by the tenant and independent of where it is done. §8.10 lists it beside org units and positions; §10.8 gives it no code of its own, so the authority that maintains positions maintains jobs.';
comment on table public.position is 'A position: one place in the structure that an employee can be assigned to. Its job is a foreign key, its org unit an edge in org_hierarchy, and whether it is vacant or filled is a query against position_assignment rather than a column, because a position does not know who holds it.';
comment on column public.position.is_valid is 'False stops new assignments to this position and leaves the ones already standing. It does not end an assignment: that is a date, not a flag.';
comment on table public.org_hierarchy is 'The structure itself: STRUCTURE rows for what hangs below what, REPORTS_TO rows for the reporting line between positions. One parent per child per relation by the primary key; no cycles and at most ten levels by the service, in the shape 0052 set for cost centre nodes.';
comment on table public.position_assignment is 'One employee''s position and cost centre for a span of validity. A change creates a new dated row and delimits the one it replaces; no row is deleted and no span is rewritten once a newer row has taken over. An employee has one assignment standing on any day, so personnel cost has exactly one place to go.';
comment on column public.position_assignment.cost_center is 'The cost centre that carried this employee for the span, with the controlling area that owns it. It is checked against the dated cost centre master when the assignment is written. The split of one person across several cost centres is not modelled, because no rule in this design says how it would divide.';
comment on column public.position_assignment.valid_to is 'The last day the assignment applies, inclusive, null while it is open. Ending or correcting an assignment writes this once, which is the only change to a span that history ever takes.';

-- Tenant-scoped, each table written out plainly: every policy the platform judges new tables by is this one
-- (D-041), and a reader checking that one table is covered should not have to evaluate a loop to find out.
do $$
begin
  alter table public.org_unit enable row level security;
  alter table public.org_unit force row level security;
  drop policy if exists tenant_isolation on public.org_unit;
  create policy tenant_isolation on public.org_unit
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.org_unit from public;

  alter table public.job enable row level security;
  alter table public.job force row level security;
  drop policy if exists tenant_isolation on public.job;
  create policy tenant_isolation on public.job
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.job from public;

  alter table public.position enable row level security;
  alter table public.position force row level security;
  drop policy if exists tenant_isolation on public.position;
  create policy tenant_isolation on public.position
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.position from public;

  alter table public.org_hierarchy enable row level security;
  alter table public.org_hierarchy force row level security;
  drop policy if exists tenant_isolation on public.org_hierarchy;
  create policy tenant_isolation on public.org_hierarchy
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.org_hierarchy from public;

  alter table public.position_assignment enable row level security;
  alter table public.position_assignment force row level security;
  drop policy if exists tenant_isolation on public.position_assignment;
  create policy tenant_isolation on public.position_assignment
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.position_assignment from public;
end
$$;

-- What the screens actually do, stated as privileges rather than left to a reader's inference: the three
-- masters are named and retired (update), an edge of the structure is moved (update and delete), and an
-- assignment's span is delimited (update, nothing more). Delete on `org_hierarchy` is the only delete in
-- the slice and it is deliberate; delete on a person's assignment is neither granted here nor available
-- from the platform defaults.
grant update on table public.org_unit to cairn_app;
grant update on table public.job to cairn_app;
grant update on table public.position to cairn_app;
grant update on table public.org_hierarchy to cairn_app;
grant delete on table public.org_hierarchy to cairn_app;
grant update on table public.position_assignment to cairn_app;

-- The three codes §10.8 has been carrying. None is posting-relevant, and the descriptions say so: this
-- slice decides where a person sits and which cost centre carries them, and posts nothing. That the cost
-- centre is recorded here is what the payroll posting of §15.2 will one day need; recording it is not
-- posting it.
insert into capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.ORGUNIT.CREATE', 'PEOPLE', 'CREATE', false,
   'Define organisational units, their names, and where they hang in the tree at /people/organization '
   || '(PPOCE). A unit is retired by validity rather than deleted while positions or other units cite it. '
   || 'The tree itself is not dated, so the structure reads as today.''s.'),
  ('PEOPLE.POSITION.CREATE', 'PEOPLE', 'CREATE', false,
   'Define positions and jobs, the job a position carries, the unit it stands in, and the position it '
   || 'reports to at /people/organization (PPOME). §10.8 has no code of its own for jobs, so the authority '
   || 'that maintains positions maintains them. A position does not know who holds it: that is a question '
   || 'for the assignment.'),
  ('PEOPLE.ASSIGNMENT.MAINTAIN', 'PEOPLE', 'MAINTAIN', false,
   'Assign an employee to a position and a cost centre with validity dates, change it by creating a new '
   || 'dated assignment, and end it at /people/assignments (PA30). One employee has one assignment standing '
   || 'on any day; history is never deleted. Nothing is posted for the cost centre named here — payroll '
   || 'posting is not built (D-013, R-11, §15.3).')
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- No role_capability rows. They were withheld for 9193's People codes on the same ground, which still
-- holds: no People role model is a decision yet, so an operational code is not widened on a migration's
-- own authority, and an administrator's '*' pattern reaches the screens in the meantime.

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values (
  gen_random_uuid()::text, 'PEOPLE.ORGUNIT.CREATE', 'org_unit', 'Organisational unit maintain',
  'TRANSACTION', 'PEOPLE',
  'The units an organisation is carved into, and the tree they stand in. A unit carries a name, a validity '
  || 'flag and a parent; it carries no company code and no cost centre, because no rule here assigns one. '
  || 'The structure is not effective-dated, so a change today is the only version there is.',
  'TIER_1_CORE', '/people/organization', 'B', 'MIGRATION_9194'
), (
  gen_random_uuid()::text, 'PEOPLE.POSITION.CREATE', 'position', 'Position maintain', 'TRANSACTION', 'PEOPLE',
  'Positions and jobs: a position is one place someone can stand, a job is what is done there, and the '
  || 'reporting line joins one position to the position above it. Whether a position is filled is read '
  || 'from the assignments, never stored on it. Vacancies and headcount planning are not modelled.',
  'TIER_1_CORE', '/people/organization', 'B', 'MIGRATION_9194'
), (
  gen_random_uuid()::text, 'PEOPLE.ASSIGNMENT.MAINTAIN', 'position_assignment',
  'Position/employee/cost centre assignment', 'TRANSACTION', 'PEOPLE',
  'Putting a person in a position and a cost centre for a span of dates. A change is a new dated '
  || 'assignment that delimits the one it replaces, never an overwrite; one employee cannot overlap '
  || 'themselves. Posting personnel cost to the cost centre named here is not built (§15.3, D-013).',
  'TIER_1_CORE', '/people/assignments', 'B', 'MIGRATION_9194'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9194',
  changed_at = now();
