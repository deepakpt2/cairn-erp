-- 9314_employee_tiers.sql
--
-- Tiers and hire approval.
--
-- * position.tier (1..9, default 1): the authority tier the org chart gives a position. An employee's tier is the
--   tier of the position they hold today (else the one they last held, else the proposed one while a hire is
--   pending, else 1). Acting on an employee needs a tier strictly above theirs.
-- * employee.hire_status: ACTIVE (every existing row), PENDING (a hire request awaiting a higher tier) or REJECTED.
--   A pending hire is never active. The request carries the proposed position (its tier) and plant (its reach).
-- * PEOPLE.EMPLOYEE.APPROVE is registered and granted to no role.
alter table public.position
  add column if not exists tier smallint not null default 1;
alter table public.position
  add constraint position_tier_ck check (tier between 1 and 9);

alter table public.employee
  add column if not exists hire_status varchar(10) not null default 'ACTIVE',
  add column if not exists proposed_position_code varchar(10),
  add column if not exists proposed_plant varchar(4),
  add column if not exists hire_requested_by varchar(60),
  add column if not exists hire_decided_by varchar(60),
  add column if not exists hire_decided_at timestamptz,
  add column if not exists hire_note varchar(200);
alter table public.employee
  add constraint employee_hire_status_ck check (hire_status in ('ACTIVE', 'PENDING', 'REJECTED')),
  add constraint employee_hire_pending_ck check (hire_status <> 'PENDING' or is_active = false);

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.EMPLOYEE.APPROVE', 'PEOPLE', 'APPROVE', false, 'Approve or reject a pending hire; the approver''s tier must be above the new hire''s')
on conflict (code) do nothing;
