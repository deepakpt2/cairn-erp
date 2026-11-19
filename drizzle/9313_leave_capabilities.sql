-- 9313_leave_capabilities.sql
--
-- Registers the leave capabilities 9311 introduced (so the role editor lists them). None is granted to any role
-- here: leave authority is withheld on purpose. PEOPLE.LEAVE.APPROVE was copied to the roles that held
-- PEOPLE.TIME.ENTER by 9311 and is unchanged.
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.LEAVE.CONFIGURE', 'PEOPLE', 'CONFIGURE', false, 'Define time types and versioned leave policies'),
  ('PEOPLE.LEAVE.ASSIGN',    'PEOPLE', 'MAINTAIN',  false, 'Maintain leave groups, group membership and policy assignments (group or person)'),
  ('PEOPLE.LEAVE.APPROVE',   'PEOPLE', 'APPROVE',   false, 'Approve, reject or cancel an absence request, within the Company Code scope'),
  ('PEOPLE.LEAVE.ADJUST',    'PEOPLE', 'MAINTAIN',  false, 'Post a balance adjustment and convert legacy quotas to policy balances'),
  ('PEOPLE.LEAVE.EXPORT',    'PEOPLE', 'EXPORT',    false, 'Export leave balances as CSV, including the queued large export'),
  ('PEOPLE.LEAVE.ACCRUE',    'PEOPLE', 'EXECUTE',   false, 'Start a manual or backfill leave accrual run and read its status')
on conflict (code) do nothing;
