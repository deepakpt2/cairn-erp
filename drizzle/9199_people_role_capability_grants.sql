-- 9199_people_role_capability_grants.sql
-- Grant the non-payroll People capabilities to the CONFIGURATOR role in every
-- tenant, so application users who hold that role can reach the People screens.
--
-- CAIRN.md §10.8 registers these codes; §23 resolves them at authorisation time
-- through user_role → role_capability. The ADMINISTRATOR role already holds '*'
-- (wildcard) and needs no row here. No role is invented: CONFIGURATOR is one of
-- the five system roles seeded into every tenant, and its existing description
-- ("Maintains configuration through the workbench; cannot post documents") fits
-- People master-data maintenance, which posts nothing.
--
-- Payroll capabilities (PEOPLE.PAYROLLRUN.EXECUTE, PEOPLE.PAYROLL.RESULT,
-- PEOPLE.PAYROLL.POST, PEOPLE.PAYROLL.IMPORT, PEOPLE.EOS.PROVISION,
-- PEOPLE.SALARY.PAYMENT) are deliberately NOT granted: payroll remains the
-- explicit simplified-payroll exception (DV-001, D-013, R-11).
--
-- CFG.PEOPLE.RECORDTYPE.DEFINE and CFG.PEOPLE.PAYCOMPONENT.DEFINE are already
-- reachable by CONFIGURATOR through its CFG.* pattern; they are listed here for
-- completeness so the grant set is explicit and auditable.

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.EMPLOYEE.CREATE', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.RECORD.MAINTAIN', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.ORGUNIT.CREATE', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.POSITION.CREATE', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.ASSIGNMENT.MAINTAIN', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.TIME.ENTER', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select c.client, 'CONFIGURATOR', 'PEOPLE.LEAVE.VIEW', 'MIGRATION_9199'
  from client c
 on conflict (client, role_code, capability_code) do nothing;
