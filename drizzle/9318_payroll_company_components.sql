-- 9318_payroll_company_components.sql
--
-- Company-configured payroll additions and deductions. The company decides what is added to or deducted from an
-- employee's pay and what it contributes separately; nothing here knows any country's law.
--
--  employee_pay_component   employee-specific RECURRING earning / deduction / employer contribution, effective-dated,
--                           with an explicit ADD (extra line beside the structure) or REPLACE (suppresses that
--                           component's structure rule for the covered dates) mode and a proration policy.
--                           Rows are never rewritten: a change ends a row and adds another; a withdrawn row stays.
--                           Two ACTIVE REPLACE rows for one employee and component cannot overlap (exclusion constraint).
--  payroll_adjustment       a ONE-TIME fixed-amount entry for one company, fiscal year and period, with a mandatory
--                           reason and a separate approver. PENDING -> APPROVED -> APPLIED (set when the run that
--                           picked it up is released), or REJECTED / CANCELLED.
--  payroll_result_line      gains the source of every line (structure, employee addition/replacement, one-time
--                           adjustment), the proration policy and a readable statement of the basis used.
--
-- Audit columns follow the project rule: created_by/created_at, changed_by/changed_at.

create extension if not exists btree_gist;

create table if not exists public.employee_pay_component (
  client           varchar(4)    not null references public.client(client) on delete cascade,
  entry_id         varchar(36)   not null,
  personnel_number varchar(20)   not null,
  component_code   varchar(10)   not null,
  mode             varchar(8)    not null,
  amount_kind      varchar(20)   not null,
  amount_value     numeric(23,4) not null,
  currency         char(3)       not null,
  valid_from       date          not null,
  valid_to         date,
  proration_policy varchar(32)   not null,
  status           varchar(10)   not null default 'ACTIVE',
  reason           varchar(200)  not null,
  withdrawn_reason varchar(200),
  request_key      varchar(64),
  created_by       varchar(60)   not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  constraint employee_pay_component_pk primary key (client, entry_id),
  constraint employee_pay_component_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint employee_pay_component_component_fk foreign key (client, component_code)
    references public.pay_component (client, code) on delete restrict,
  constraint employee_pay_component_mode_ck check (mode in ('ADD', 'REPLACE')),
  constraint employee_pay_component_kind_ck check (amount_kind in ('FIXED', 'PERCENT_OF_BASE')),
  constraint employee_pay_component_value_ck check (amount_value >= 0),
  constraint employee_pay_component_percent_ck check (amount_kind <> 'PERCENT_OF_BASE' or amount_value <= 100),
  constraint employee_pay_component_policy_ck check (proration_policy in ('PAYABLE_CALENDAR_DAYS', 'NO_UNPAID_LEAVE_REDUCTION', 'FULL_PERIOD')),
  constraint employee_pay_component_status_ck check (status in ('ACTIVE', 'WITHDRAWN')),
  constraint employee_pay_component_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint employee_pay_component_period_ck check (valid_to is null or valid_to >= valid_from),
  constraint employee_pay_component_reason_ck check (length(trim(reason)) > 0),
  constraint employee_pay_component_withdrawn_ck check ((status = 'WITHDRAWN') = (withdrawn_reason is not null)),
  -- A replacement suppresses a structure component: two for the same employee, component and day would be ambiguous.
  constraint employee_pay_component_replace_overlap_ex exclude using gist (
    client with =, personnel_number with =, component_code with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  ) where (mode = 'REPLACE' and status = 'ACTIVE')
);
create index if not exists employee_pay_component_employee_idx
  on public.employee_pay_component (client, personnel_number, valid_from);
create unique index if not exists employee_pay_component_request_uq
  on public.employee_pay_component (client, request_key) where request_key is not null;
comment on table public.employee_pay_component is
  'Employee-specific recurring payroll components. ADD = extra line beside the structure; REPLACE = replaces that component''s structure rule for the dates. Company-maintained values: the ERP applies them, it does not determine legal rates.';

create table if not exists public.payroll_adjustment (
  client             varchar(4)    not null references public.client(client) on delete cascade,
  adjustment_id      varchar(36)   not null,
  company_code       varchar(4)    not null,
  fiscal_year        integer       not null,
  period             integer       not null,
  personnel_number   varchar(20)   not null,
  component_code     varchar(10)   not null,
  component_kind     varchar(24)   not null,
  amount             numeric(23,4) not null,
  currency           char(3)       not null,
  reason             varchar(200)  not null,
  source_reference   varchar(100),
  corrects_result_id varchar(36),
  status             varchar(10)   not null default 'PENDING',
  decided_by         varchar(60),
  decided_at         timestamp with time zone,
  decision_note      varchar(200),
  applied_run_id     varchar(36),
  applied_result_id  varchar(36),
  applied_at         timestamp with time zone,
  request_key        varchar(64),
  created_by         varchar(60)   not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  constraint payroll_adjustment_pk primary key (client, adjustment_id),
  constraint payroll_adjustment_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint payroll_adjustment_component_fk foreign key (client, component_code)
    references public.pay_component (client, code) on delete restrict,
  constraint payroll_adjustment_applied_run_fk foreign key (client, applied_run_id)
    references public.payroll_run (client, run_id) on delete restrict,
  constraint payroll_adjustment_status_ck check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED')),
  constraint payroll_adjustment_kind_ck check (component_kind in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION')),
  constraint payroll_adjustment_amount_ck check (amount > 0),
  constraint payroll_adjustment_period_ck check (period between 1 and 16),
  constraint payroll_adjustment_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint payroll_adjustment_reason_ck check (length(trim(reason)) > 0),
  -- The approver is never the creator; a rejection and an approval both name who decided, when and (rejection) why.
  constraint payroll_adjustment_separation_ck check (decided_by is null or lower(decided_by) <> lower(created_by)),
  constraint payroll_adjustment_decision_ck check (
    (status = 'PENDING' and decided_by is null)
    or (status in ('APPROVED', 'REJECTED', 'APPLIED') and decided_by is not null and decided_at is not null)
    or status = 'CANCELLED'
  ),
  constraint payroll_adjustment_reject_note_ck check (status <> 'REJECTED' or length(trim(coalesce(decision_note, ''))) > 0),
  constraint payroll_adjustment_applied_ck check ((status = 'APPLIED') = (applied_run_id is not null))
);
create index if not exists payroll_adjustment_period_idx
  on public.payroll_adjustment (client, company_code, fiscal_year, period, status);
create index if not exists payroll_adjustment_employee_idx
  on public.payroll_adjustment (client, personnel_number);
create unique index if not exists payroll_adjustment_request_uq
  on public.payroll_adjustment (client, request_key) where request_key is not null;
comment on table public.payroll_adjustment is
  'One-time payroll adjustment for one employee and period. Approved by a person other than the creator; applied exactly once when the run that calculated it is released.';

alter table public.payroll_result_line
  add column if not exists source_type      varchar(16) not null default 'STRUCTURE',
  add column if not exists source_id        varchar(36),
  add column if not exists proration_policy varchar(32),
  add column if not exists calc_basis       varchar(240);
alter table public.payroll_result_line drop constraint if exists payroll_result_line_source_ck;
alter table public.payroll_result_line add constraint payroll_result_line_source_ck
  check (source_type in ('STRUCTURE', 'EMPLOYEE_ADD', 'EMPLOYEE_REPLACE', 'ONE_TIME'));

do $$
declare
  t text;
begin
  foreach t in array array['employee_pay_component', 'payroll_adjustment'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update on table public.employee_pay_component to cairn_app;
grant select, insert, update on table public.payroll_adjustment to cairn_app;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.PAYROLL.COMPONENT.MAINTAIN', 'PEOPLE', 'MAINTAIN', false,
   'Maintain employee-specific recurring payroll components (additions, deductions, employer contributions, replacements of a structure rule) on the employee screen'),
  ('PEOPLE.PAYROLL.ADJUSTMENT.ENTER', 'PEOPLE', 'CREATE', false,
   'Enter and cancel one-time payroll adjustments for an employee and period'),
  ('PEOPLE.PAYROLL.ADJUSTMENT.APPROVE', 'PEOPLE', 'APPROVE', false,
   'Approve or reject a one-time payroll adjustment entered by someone else')
on conflict do nothing;
