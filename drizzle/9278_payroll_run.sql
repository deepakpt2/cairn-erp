-- 9278_payroll_run.sql
--
-- Payroll phase 2: the run, its exceptions, the result and the result line.
-- Nothing here posts; phase 3 does that through the PR document type.
--
-- A run is one company code, one fiscal period. It is PROPOSED (may be
-- recalculated), then RELEASED (frozen — never recalculated: SAP's rule for a
-- payroll result, and DV-001, no retroactive accounting), then POSTED by phase 3.
-- A correction is a new run in a later period. CANCELLED frees the period.
--
-- The result line snapshots everything posting needs (both accounts, the cost
-- receiver and the cost centre), so configuration may change after calculation
-- without changing what a calculated result says.
--
-- House conventions over the phase-2 prompt's draft SQL: the audit columns are
-- created_by/created_at/changed_by/changed_at as on every other table, and every
-- table carries row level security and the cairn_app grants.

-- ── The run ────────────────────────────────────────────────────────────────
create table if not exists public.payroll_run (
  client         varchar(4)  not null references public.client(client) on delete cascade,
  run_id         varchar(36) not null,
  company_code   varchar(4)  not null,
  fiscal_year    integer not null,
  period         integer not null,
  period_from    date not null,
  period_to      date not null,
  total_days     integer not null,
  currency       varchar(3)  not null,
  status         varchar(12) not null default 'PROPOSED',
  employee_count integer not null default 0,
  exception_count integer not null default 0,
  calculated_by  varchar(60) not null,
  calculated_at  timestamp with time zone not null default now(),
  released_by    varchar(60),
  released_at    timestamp with time zone,
  cancelled_by   varchar(60),
  cancelled_at   timestamp with time zone,
  cancel_reason  varchar(200),
  request_key    varchar(64),
  created_by     varchar(60) not null default 'SYSTEM',
  created_at     timestamp with time zone not null default now(),
  changed_by     varchar(60),
  changed_at     timestamp with time zone,
  primary key (client, run_id),
  constraint payroll_run_period_ck check (period between 1 and 16),
  constraint payroll_run_dates_ck check (period_to >= period_from),
  constraint payroll_run_days_ck check (total_days > 0),
  constraint payroll_run_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
  constraint payroll_run_status_ck
    check (status in ('PROPOSED','RELEASED','POSTED','CANCELLED')),
  constraint payroll_run_released_ck
    check (status not in ('RELEASED','POSTED') or (released_by is not null and released_at is not null)),
  constraint payroll_run_cancelled_ck
    check (status <> 'CANCELLED' or (cancelled_by is not null and cancel_reason is not null)),
  constraint payroll_run_company_fk foreign key (client, company_code)
    references public.company_code (client, company_code) on delete restrict
);
-- One live run per company, year and period; a cancelled run frees the period.
create unique index if not exists payroll_run_period_uq
  on public.payroll_run (client, company_code, fiscal_year, period)
  where status <> 'CANCELLED';
create unique index if not exists payroll_run_request_key_uq
  on public.payroll_run (client, request_key)
  where request_key is not null;
comment on table public.payroll_run is
  'One payroll period for one company code (SAP payroll driver run). PROPOSED → RELEASED (frozen) → POSTED (phase 3); CANCELLED frees the period.';

-- ── Employees a run could not include, each with its named reason ──────────
create table if not exists public.payroll_run_exception (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  run_id           varchar(36) not null,
  personnel_number varchar(20) not null,
  seq              integer not null,
  reason_code      varchar(32) not null,
  message          varchar(400) not null,
  remedy           varchar(400),
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, run_id, personnel_number, seq),
  constraint payroll_run_exception_run_fk foreign key (client, run_id)
    references public.payroll_run (client, run_id) on delete cascade,
  constraint payroll_run_exception_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict
);
comment on table public.payroll_run_exception is
  'An employee selected for a run but not ready for it, with the readiness reason. Never dropped silently; a run with exceptions cannot be released.';

-- ── One employee's result in one run ───────────────────────────────────────
create table if not exists public.payroll_result (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  result_id          varchar(36) not null,
  run_id             varchar(36) not null,
  personnel_number   varchar(20) not null,
  origin             varchar(12) not null default 'CALCULATED',
  currency           varchar(3)  not null,
  payable_days       numeric(6,2) not null,
  total_days         numeric(6,2) not null,
  covered_days       numeric(6,2) not null,
  unpaid_leave_days  numeric(6,2) not null default 0,
  gross_pay          numeric(23,4) not null default 0,
  total_deductions   numeric(23,4) not null default 0,
  net_pay            numeric(23,4) not null default 0,
  employer_cost      numeric(23,4) not null default 0,
  cost_center        varchar(10),
  controlling_area   varchar(4),
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  primary key (client, result_id),
  constraint payroll_result_run_fk foreign key (client, run_id)
    references public.payroll_run (client, run_id) on delete cascade,
  constraint payroll_result_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint payroll_result_origin_ck check (origin in ('CALCULATED','IMPORTED')),
  constraint payroll_result_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
  constraint payroll_result_days_ck
    check (payable_days >= 0 and payable_days <= covered_days and covered_days <= total_days),
  constraint payroll_result_unpaid_ck check (unpaid_leave_days >= 0),
  constraint payroll_result_net_ck check (net_pay = gross_pay - total_deductions),
  constraint payroll_result_cost_pair_ck
    check ((controlling_area is null and cost_center is null)
        or (controlling_area is not null and cost_center is not null))
);
create unique index if not exists payroll_result_employee_uq
  on public.payroll_result (client, run_id, personnel_number);
create index if not exists payroll_result_run_idx
  on public.payroll_result (client, run_id);
comment on table public.payroll_result is
  'One employee''s result in one run (SAP payroll result, cluster RX). Frozen once the run is released.';

-- ── One component of one result, for one segment of the period ─────────────
-- A segment is a contiguous span with one position assignment and one salary
-- assignment; a mid-period transfer or raise gives the result one line per
-- component per segment, each prorated and rounded once on its own.
create table if not exists public.payroll_result_line (
  client                  varchar(4)  not null references public.client(client) on delete cascade,
  result_id               varchar(36) not null,
  line_id                 varchar(36) not null,
  line_no                 integer not null,
  segment_from            date not null,
  segment_to              date not null,
  payable_days            numeric(6,2) not null,
  structure_code          varchar(10) not null,
  base_amount             numeric(23,4) not null,
  component_code          varchar(10) not null,
  component_kind          varchar(24) not null,
  amount_kind             varchar(20),
  amount_value            numeric(23,4),
  amount                  numeric(23,4) not null,
  debit_account           varchar(10),
  credit_account          varchar(10),
  cost_receiver_category  varchar(10) not null default 'NONE',
  cost_center             varchar(10),
  controlling_area        varchar(4),
  created_by              varchar(60) not null default 'SYSTEM',
  created_at              timestamp with time zone not null default now(),
  changed_by              varchar(60),
  changed_at              timestamp with time zone,
  primary key (client, result_id, line_id),
  constraint payroll_result_line_result_fk foreign key (client, result_id)
    references public.payroll_result (client, result_id) on delete cascade,
  constraint payroll_result_line_amount_ck check (amount >= 0),
  constraint payroll_result_line_segment_ck check (segment_to >= segment_from),
  constraint payroll_result_line_days_ck check (payable_days >= 0),
  constraint payroll_result_line_kind_ck
    check (component_kind in ('EARNING','DEDUCTION','EMPLOYER_CONTRIBUTION')),
  constraint payroll_result_line_receiver_ck
    check (cost_receiver_category in ('ASSIGNMENT','FIXED','NONE')),
  constraint payroll_result_line_cost_pair_ck
    check ((controlling_area is null and cost_center is null)
        or (controlling_area is not null and cost_center is not null))
);
create index if not exists payroll_result_line_result_idx
  on public.payroll_result_line (client, result_id);
comment on table public.payroll_result_line is
  'One component of one result for one segment. Snapshots the accounts and cost receiver at calculation time; posting never re-reads configuration.';

-- ── Row level security and the runtime grants ───────────────────────────────
-- Results and exceptions of a PROPOSED run are replaced when it is recalculated,
-- so the app may delete those two (the service refuses it for any other status).
-- A structure component may now be removed from its structure (phase 2 refuses
-- EOS_PROVISION components, so a structure naming one must be able to drop it).
do $$
declare
  t text;
begin
  foreach t in array array['payroll_run','payroll_run_exception','payroll_result','payroll_result_line'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update on table public.payroll_run to cairn_app;
grant select, insert, delete on table public.payroll_run_exception to cairn_app;
grant select, insert, delete on table public.payroll_result to cairn_app;
grant select, insert, delete on table public.payroll_result_line to cairn_app;
grant delete on table public.salary_structure_component to cairn_app;

-- ── Registry: the run and result screens now stand ──────────────────────────
update public.term_registry
   set route_path = '/people/payroll-runs', deferral_note = null,
       description = 'Propose, recalculate, release or cancel a payroll run for one company and period: '
         || 'prorated by assignment validity, less unpaid approved leave. Posting is phase 3.',
       changed_by = 'MIGRATION_9278', changed_at = now()
 where id = '9277a000-0000-4000-8000-000000000002';
update public.term_registry
   set route_path = '/people/payroll-results', deferral_note = null,
       description = 'Read the payroll results of a run: one slip per employee, one line per component, '
         || 'with the accounts and cost receiver each line will post to.',
       changed_by = 'MIGRATION_9278', changed_at = now()
 where id = '9277a000-0000-4000-8000-000000000003';
