-- 9281_payroll_followup.sql
--
-- Payroll phase 5: off-cycle runs, result immutability, and the result line's
-- relation. No earlier migration is touched.

-- ── A · Off-cycle runs ──────────────────────────────────────────────────────
-- A period may hold more than one run. What it may not hold is one employee
-- twice, which the coverage trigger below now enforces instead of the index.
drop index if exists public.payroll_run_period_uq;

alter table public.payroll_run
  add column if not exists predecessor_run_id varchar(36);

alter table public.payroll_run drop constraint if exists payroll_run_predecessor_fk;
alter table public.payroll_run
  add constraint payroll_run_predecessor_fk
  foreign key (client, predecessor_run_id)
  references public.payroll_run (client, run_id) on delete set null;

comment on column public.payroll_run.predecessor_run_id is
  'The run this off-cycle run follows: the live run of the same company and period that covered most of the employees this run excluded. Null for an ordinary run.';

-- ── D · The result line's relation ──────────────────────────────────────────
-- 9278 already declared payroll_result_line_result_fk; this keeps a database
-- built without it in step, and does nothing where it stands.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.payroll_result_line'::regclass
       and conname = 'payroll_result_line_result_fk'
  ) then
    alter table public.payroll_result_line
      add constraint payroll_result_line_result_fk
      foreign key (client, result_id)
      references public.payroll_result (client, result_id) on delete cascade;
  end if;
end $$;

-- ── A · Coverage: no employee is paid twice for one period ──────────────────
-- SECURITY DEFINER escapes row level security entirely, so every read here is
-- scoped on the row's own client, as the policy would have scoped it.
create or replace function payroll_result_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other   varchar(36);
  v_company varchar(4);
  v_year    integer;
  v_period  integer;
begin
  select run.company_code, run.fiscal_year, run.period
    into v_company, v_year, v_period
    from payroll_run run
   where run.client = new.client and run.run_id = new.run_id;

  select r.run_id
    into v_other
    from payroll_result r
    join payroll_run run
      on run.client = r.client and run.run_id = r.run_id
   where r.client = new.client
     and r.personnel_number = new.personnel_number
     and r.run_id <> new.run_id
     and run.status <> 'CANCELLED'
     and run.company_code = v_company
     and run.fiscal_year  = v_year
     and run.period       = v_period
   limit 1;

  if v_other is not null then
    raise exception
      'Employee % is already covered by payroll run % for this period; an off-cycle run may only pay employees no live run covers.',
      new.personnel_number, v_other
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists payroll_result_coverage_trg on public.payroll_result;
create trigger payroll_result_coverage_trg
  before insert or update on public.payroll_result
  for each row execute function payroll_result_coverage();

-- ── D · Immutability: a released result is never deleted ────────────────────
-- The application role keeps DELETE so a PROPOSED run can be recalculated; only
-- the database can tell that apart from deleting a released result (DV-001).
-- A row removed because its tenant or its run is being removed — the cascade of
-- a deleted client — is not a payroll correction, and passes.
create or replace function payroll_result_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status varchar(12);
begin
  if not exists (select 1 from client c where c.client = old.client) then
    return old;
  end if;

  select run.status
    into v_status
    from payroll_run run
   where run.client = old.client and run.run_id = old.run_id;

  if v_status in ('RELEASED', 'POSTED') then
    raise exception
      'The payroll result for employee % belongs to run %, which stands %; a released result is never deleted.',
      old.personnel_number, old.run_id, v_status
      using errcode = '23514';
  end if;

  return old;
end;
$$;

drop trigger if exists payroll_result_immutable_trg on public.payroll_result;
create trigger payroll_result_immutable_trg
  before delete on public.payroll_result
  for each row execute function payroll_result_immutable();
