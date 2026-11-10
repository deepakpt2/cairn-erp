-- ---------------------------------------------------------------------------
-- 9195: the pay structure — pay components and the accounting mapping each one carries.
--
-- CAIRN.md §8.10 names these two tables together in one row — "pay_component, pay_component_config |
-- Pay structure and its GL/cost mapping | Wage types (concept)" — and §15.1 lists the same thing as
-- "Pay structure | Pay components (wage-type equivalent) with their accounting mapping". §10.8 has
-- carried CFG.PEOPLE.PAYCOMPONENT.DEFINE since the design as a configuration activity with a title and
-- nothing behind it: no capability row, no route, no table. This migration gives that row its tables,
-- its capability and its screen, which is what 9189 did for the settlement masters and 9194 for the
-- organisational ones.
--
-- Why this slice and not the next one: R-11 says payroll is simplified but integrated — salary and other
-- payments post to FI and charge cost centres, with no statutory tax or social-insurance calculation — and
-- DV-001 records that shipping wrong statutory logic is a liability. Both rulings leave the *structure*
-- untouched: what a component is, which account it moves, and which cost object carries it are the
-- tenant's decisions, written down once, and none of them is a calculation. This is the prerequisite the
-- other payroll rows wait on: `payroll_result_line`, `deduction_rule`, `payroll_posting_line` and the EOS
-- provision lines all cite a pay component, so a run has nothing to reference until these two tables stand.
--
-- The rules below are read off §15.2's own posting example, which is the only place the design says what a
-- component's mapping has to be able to express. That example has six lines and every one of them is
-- either "an expense charged by cost centre" or "a payable created":
--
--   Salary expense — by cost centre              DEBIT, expense account, charged to the employee's centre
--   Employer contribution expense — by cost centre  DEBIT, expense account
--   EOS provision expense — by cost centre       DEBIT, expense account
--   Net pay payable                              the CREDIT an EARNING's run creates
--   Deductions payable (by deduction type)       CREDIT, one per DEDUCTION component
--   EOS provision liability                      CREDIT, beside its expense
--
-- So the vocabulary is four kinds, and the kind decides which side of the mapping must be filled: an
-- EARNING debits an expense account, a DEDUCTION credits a payable, and an EMPLOYER_CONTRIBUTION or an
-- EOS_PROVISION does both. `gl_account.account_type` is the repository's own expense/liability vocabulary
-- (9037 and its checks), so the mapped account is validated against it rather than against a rule invented
-- here, and `gl_account.requires_cost_object` decides whether the debit half has to name where the charge
-- goes. Those two columns are why this slice can say something firm about a mapping without saying anything
-- about how an amount gets computed.
--
-- What is deliberately NOT here:
--   * Any calculation: no formulas, no wage-type bases, no "of the gross" or "per hour" rules, no
--     retro-currency, no absences or scaling. The amounts arrive from an external payroll result or, later,
--     from the rule engine of §15.3; this slice only says where an amount goes when it arrives.
--   * `deduction_rule` and `deduction_rule_condition`. §15.1 makes them configurable per jurisdiction and
--     DV-001 refuses to ship statutory logic; the jurisdiction decisions are not taken, so the tables are
--     not built. CFG.PEOPLE.DEDUCTION.DEFINE stays the inert activity it has been, and a DEDUCTION component
--     here is the *account* a deduction settles against, not the rule that computes it.
--   * `payroll_run`, `payroll_result*`, `payroll_posting_*`, `eos_provision_*`, `time_recording`,
--     `absence`, `attendance`, `leave_quota`, and payslips. All remain §15.1 rows with no tables yet;
--     D-022 also puts any of their runs on a worker container rather than in a request, which is a second
--     reason not to sketch them inside a configuration migration.
--   * Amount limits, employee-level assignments of components, and per-employee values. Who gets what is a
--     payroll result or an infotype record, not a pay-structure definition; a tenant that wants an amount per
--     person today can write it as a dated record of a configured type (9193), which is what that mechanism
--     is for.
--   * Effective dates on these two tables. §15.1 asks for validity dates on the Assignment alone, so the
--     structure and the mapping follow the repository's own answer for the masters beside them: 9194's org
--     units and 0050/0052's controlling-area trees are undated, corrected in place, and retired by validity.
--     A mapping that changes mid-year is therefore corrected and the change document is the audit trail;
--     what it cannot answer is "which account stood here in March", which is recorded as a limit rather
--     than designed away.
--
-- One row per component and chart, holding both sides, rather than one row per side: the key a per-side
-- design would need (component, chart, side) cannot be corrected in place, and this slice grants no DELETE —
-- a mis-keyed row would be stranded. A row whose side is wrong is instead edited, which is the shape every
-- other configuration master here has.
--
-- Rights: select and insert come from the platform defaults (9186), update is granted per table for the
-- change forms, and no delete is granted anywhere, so neither a component nor a mapping can be removed
-- while something cites it. `revoke … from public` and the tenant policies are written out per table, as
-- every People migration in this slice has done (D-041).
-- ---------------------------------------------------------------------------

create table if not exists public.pay_component (
  client          varchar(4)  not null references public.client (client) on delete cascade,
  code            varchar(10) not null,
  name            varchar(60) not null,
  component_kind  varchar(24) not null,
  -- Pinned to the kind rather than asked for, in the manner of `gl_account.is_balance_sheet`: a component
  -- that changes what the employee is paid is an earning or a deduction, and one that does not is an
  -- employer cost or a provision. Two answers to the same question would disagree eventually.
  affects_net_pay boolean     not null default false,
  description     varchar(200),
  is_valid        boolean     not null default true,
  created_by      varchar(60) not null default 'SYSTEM',
  created_at      timestamptz not null default now(),
  changed_by      varchar(60),
  changed_at      timestamptz,
  constraint pay_component_pk primary key (client, code),
  constraint pay_component_code_format_ck check (code ~ '^([A-Z][A-Z0-9]{1,9})$'),
  constraint pay_component_name_length_ck check (length(trim(name)) > 0),
  constraint pay_component_kind_vocabulary_ck check (
    component_kind in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'EOS_PROVISION')
  ),
  constraint pay_component_net_effect_ck check (
    affects_net_pay = (component_kind in ('EARNING', 'DEDUCTION'))
  )
);

comment on table public.pay_component is
  'A pay component: what money moves to or for an employee, in the tenant''s own vocabulary (§8.10, wage-type equivalent). Names, the kind, and nothing about amount — calculation is not built (R-11, DV-001). Maintained at /config/pay-components under CFG.PEOPLE.PAYCOMPONENT.DEFINE; retired by validity, never deleted, because a payroll result line will cite it by code.';
comment on column public.pay_component.component_kind is
  'EARNING and DEDUCTION change what the employee is paid; EMPLOYER_CONTRIBUTION and EOS_PROVISION are the tenant''s own cost. The kind decides which side of the mapping must stand, which is §15.2''s posting example written as a vocabulary instead of a paragraph.';
comment on column public.pay_component.is_valid is
  'False stops a new mapping and stops the component being offered to anything that reads the structure; it does not touch a mapping that already stands or a result already imported. The same meaning validity has on 9194''s masters.';

create table if not exists public.pay_component_config (
  client                 varchar(4)  not null references public.client (client) on delete cascade,
  component_code         varchar(10) not null,
  chart_of_accounts      varchar(4)  not null,
  -- The two sides of §15.2, either of which may be the only one a component needs. Both are accounts of
  -- this tenant's chart, both are foreign keys, and the kind decides which is required — in the service,
  -- because the check would have to reach into another table.
  debit_account          varchar(10),
  credit_account         varchar(10),
  -- Where a debit is charged. ASSIGNMENT follows the cost centre of the employee's assignment (9194),
  -- FIXED names a centre of its own for a tenant that charges a component centrally, NONE takes no cost
  -- object at all. A cost object is never invented: an account whose master demands one is refused.
  cost_receiver_category varchar(10) not null default 'NONE',
  controlling_area       varchar(4),
  cost_center            varchar(10),
  created_by             varchar(60) not null default 'SYSTEM',
  created_at             timestamptz not null default now(),
  changed_by             varchar(60),
  changed_at             timestamptz,
  constraint pay_component_config_pk primary key (client, component_code, chart_of_accounts),
  constraint pay_component_config_chart_format_ck check (chart_of_accounts ~ '^[A-Z0-9]{4}$'),
  constraint pay_component_config_debit_format_ck check (
    debit_account is null or debit_account ~ '^[A-Z0-9]{1,10}$'
  ),
  constraint pay_component_config_credit_format_ck check (
    credit_account is null or credit_account ~ '^[A-Z0-9]{1,10}$'
  ),
  constraint pay_component_config_not_hollow_ck check (
    debit_account is not null or credit_account is not null
  ),
  constraint pay_component_config_sides_differ_ck check (
    debit_account is null or credit_account is null or debit_account <> credit_account
  ),
  constraint pay_component_config_receiver_vocabulary_ck check (
    cost_receiver_category in ('ASSIGNMENT', 'FIXED', 'NONE')
  ),
  constraint pay_component_config_area_format_ck check (
    controlling_area is null or controlling_area ~ '^[A-Z0-9]{4}$'
  ),
  constraint pay_component_config_center_format_ck check (
    cost_center is null or cost_center ~ '^[A-Z0-9]{1,10}$'
  ),
  -- The pair stands or falls together: an area with no centre, or a centre nobody has agreed to charge,
  -- is a half-written mapping.
  constraint pay_component_config_cost_pair_ck check (
    (controlling_area is null and cost_center is null) or (controlling_area is not null and cost_center is not null)
  ),
  -- Only a charge can carry a cost object. The credit side of §15.2 is a payable, and a payable posted to
  -- a cost centre would double the charge the debit side already makes.
  constraint pay_component_config_cost_only_with_debit_ck check (
    (debit_account is not null) or (cost_receiver_category = 'NONE' and controlling_area is null and cost_center is null)
  ),
  constraint pay_component_config_fixed_needs_centre_ck check (
    cost_receiver_category <> 'FIXED' or (controlling_area is not null and cost_center is not null)
  ),
  constraint pay_component_config_assignment_needs_nothing_ck check (
    cost_receiver_category <> 'ASSIGNMENT' or (controlling_area is null and cost_center is null)
  ),
  -- A component is a thing the tenant has defined; removing it is not this table''s business, and the
  -- restrict below is what makes "retire, never delete" a fact rather than a habit.
  constraint pay_component_config_component_fk foreign key (client, component_code)
    references public.pay_component (client, code) on delete restrict,
  constraint pay_component_config_debit_account_fk foreign key (client, chart_of_accounts, debit_account)
    references public.gl_account (client, chart_of_accounts, account_number) on delete restrict,
  constraint pay_component_config_credit_account_fk foreign key (client, chart_of_accounts, credit_account)
    references public.gl_account (client, chart_of_accounts, account_number) on delete restrict
);

create index if not exists pay_component_config_chart_idx
  on public.pay_component_config (client, chart_of_accounts, component_code);

comment on table public.pay_component_config is
  'The accounting mapping of one pay component within one chart of accounts (§8.10''s "GL/cost mapping"): the expense side, the payable side, and where the charge goes. It says nothing about amounts and posts nothing — a payroll posting run would read it (D-013, R-11). Maintained at /config/pay-components under CFG.PEOPLE.PAYCOMPONENT.DEFINE.';
comment on column public.pay_component_config.debit_account is
  'The expense account the component charges, required for a kind that costs the tenant money. Validated against gl_account: it must stand in this chart, must be an EXPENSE account, and must not be blocked for posting.';
comment on column public.pay_component_config.credit_account is
  'The payable the component creates, required for a kind that owes someone. Validated the same way against a LIABILITY account. Net pay itself is not here: it is the run''s own credit, not a component''s.';
comment on column public.pay_component_config.cost_receiver_category is
  'ASSIGNMENT charges the cost centre the employee''s assignment names (9194''s position_assignment), FIXED charges the centre named on this row, NONE charges nothing. An account whose master sets requires_cost_object cannot be mapped to NONE.';
comment on column public.pay_component_config.cost_center is
  'The fixed centre to charge, with the controlling area that owns it, only when the category is FIXED. Checked as of today against the dated cost-centre master, because a mapping has no dates of its own.';

-- Tenant-scoped, each table written out plainly: every policy the platform judges new tables by is this one
-- (D-041), and a reader checking that a table is covered should not have to evaluate a loop to find out.
do $$
begin
  alter table public.pay_component enable row level security;
  alter table public.pay_component force row level security;
  drop policy if exists tenant_isolation on public.pay_component;
  create policy tenant_isolation on public.pay_component
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.pay_component from public;

  alter table public.pay_component_config enable row level security;
  alter table public.pay_component_config force row level security;
  drop policy if exists tenant_isolation on public.pay_component_config;
  create policy tenant_isolation on public.pay_component_config
    as permissive for all
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
  revoke all on table public.pay_component_config from public;
end
$$;

-- The screens name and retire a component and write or correct a mapping; nothing removes either.
grant update on table public.pay_component to cairn_app;
grant update on table public.pay_component_config to cairn_app;

-- The code §10.8's configuration column has carried. Not posting-relevant: defining where a component
-- would post is not posting, and the description says so in the same words 9194 used for the assignment.
insert into capability (code, module, action, is_posting_relevant, description) values
  ('CFG.PEOPLE.PAYCOMPONENT.DEFINE', 'PEOPLE', 'CONFIGURE', false,
   'Define pay components and the GL and cost mapping each one carries at /config/pay-components. '
   || 'A component is the tenant''s name for a kind of pay — an earning, a deduction, an employer '
   || 'contribution, an end-of-service provision — and the mapping says which account of which chart it '
   || 'moves and whether a cost centre carries it. Nothing is calculated and nothing is posted: payroll '
   || 'calculation is not built (D-013, R-11, DV-001), and this row is what a posting run would one day read.')
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- The activity gets the route it always meant to have. Both People configuration steps were registered as
-- titles with no path, which the browser run for 9193 caught: the workbench listed the step and could not
-- open it, so the only way to the screen was to know its address. Setting route_path here and in the seed
-- list closes that for every environment, including ones that never re-run the seed.
insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
) values
  ('CFG.PEOPLE.PAYCOMPONENT.DEFINE', 'PEOPLE', null, 'Define pay components', 'DEFINE',
   'CFG.PEOPLE.RECORDTYPE.DEFINE', 'What a pay component is and where its money goes, before any payroll exists',
   720, 'ONBOARDING', '/config/pay-components', true, 'MIGRATION_9195'),
  ('CFG.PEOPLE.RECORDTYPE.DEFINE', 'PEOPLE', null, 'Define employee record types', 'DEFINE',
   'CFG.ORG.COMPANYCODE.DEFINE', 'Employee master data',
   710, 'ONBOARDING', '/config/people-record-types', true, 'MIGRATION_9195')
on conflict (code) do update set
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9195',
  changed_at = now();

-- Every tenant has to pass the step, so every tenant gets a row; nothing is completed on a migration's
-- own authority, since a pay structure is exactly the thing a tenant has to decide.
insert into config_activity_status (client, activity_code, status, created_by)
select c.client, 'CFG.PEOPLE.PAYCOMPONENT.DEFINE', 'NOT_STARTED', 'MIGRATION_9195'
from client c
on conflict (client, activity_code) do nothing;

-- No role_capability rows, for the reason 9193 and 9194 recorded: no People role model is a decision yet,
-- so an operational code is not widened by a migration, and an administrator's pattern reaches the screen.

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values (
  gen_random_uuid()::text,
  'CFG.PEOPLE.PAYCOMPONENT.DEFINE',
  'pay_component',
  'Define pay components',
  'CONFIG_ACTIVITY',
  'PEOPLE',
  $pc95$Pay components and their mappings: what a tenant calls a kind of pay, which account of which chart it moves, and whether a cost centre carries it. A component is retired by validity and never deleted while a mapping cites it; the mapping is corrected in place, which is why no account is removed from under it. No amount is computed here — the payroll calculation rules are the tenant's jurisdiction decisions (§15.3), and CAIRN.md refuses to ship guessed ones.$pc95$,
  'TIER_2_CONFIGURED',
  '/config/pay-components',
  'B',
  'MIGRATION_9195'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9195',
  changed_at = now();

-- No term_alias row. §10.8 lists no transaction code for pay components — wage types are cited in §8.10 as
-- "Wage types (concept)", a concept rather than a screen to imitate — and an alias is a promise that our
-- screen answers the reference product's transaction, which nobody has decided.
