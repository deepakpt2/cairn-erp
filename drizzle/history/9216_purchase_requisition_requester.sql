-- A requisition is raised on behalf of someone who is not the person saving it.
--
-- The requisition header stands on the item rows — document type and requisition date
-- already live there — so the requester goes there too, once per item, and is read back
-- from the first. The requester is an employee: anyone who can ask for something, whether
-- or not that person holds an application login, which is why the source is the employee
-- master and not app_user. Whoever saved the document stays in created_by, as before, so
-- "who asked" and "who entered it" remain two different facts.
--
-- Nullable, and deliberately so: planning raises requisitions with no requester at all.

alter table public.purchase_requisition_item
  add column if not exists requested_by varchar(20);

alter table public.purchase_requisition_item
  drop constraint if exists purchase_requisition_item_requester_fk;
alter table public.purchase_requisition_item
  add constraint purchase_requisition_item_requester_fk
  foreign key (client, requested_by)
  references public.employee (client, personnel_number) on delete restrict;
