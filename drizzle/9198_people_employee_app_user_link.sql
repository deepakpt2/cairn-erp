-- 9198_people_employee_app_user_link.sql
-- Optional link between an employee master record and an application user account.
--
-- CAIRN.md §23: "Employee master records are independent of application-user
-- accounts. A link is optional, validated, and unique in both directions:
-- one employee links to at most one application user, and one application
-- user links to at most one employee. Employment status (employee.is_active)
-- and account activation status (app_user.is_active) are separate columns
-- and lifecycle events; deactivating one does not touch the other."
--
-- No login account is created automatically for any employee. The link is
-- added by an administrator who holds the appropriate capability, through a
-- screen that is itself capability-gated. This migration adds only the
-- database shape; the writer, the UI and the capability grant are separate
-- work.
--
-- app_user.id is the primary key (unique across all clients), so the foreign
-- key references that column directly. employee.client remains for RLS scoping.

alter table public.employee
  add column app_user_id varchar(36);

alter table public.employee
  add constraint employee_app_user_fk
    foreign key (app_user_id)
    references public.app_user (id)
    on delete restrict;

create unique index employee_app_user_id_uq
  on public.employee (client, app_user_id)
  where app_user_id is not null;
