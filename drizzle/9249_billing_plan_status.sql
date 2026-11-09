-- 9249: a billing plan date is withdrawn, not deleted.
--
-- 9248 delivered the plan's dates with two states: open, and billed. Maintenance needs a third, and
-- the reason is the same reason an order line is rejected rather than removed and a partner function
-- is withdrawn rather than erased.
--
-- A plan is part of the commercial record of an order. It says what was agreed about when an item
-- would be billed, and an order whose plan was changed twice has been agreed three times. A tenant
-- that stops wanting a date does not get to pretend it never stood: the date is withdrawn, it answers
-- nothing from then on, and it leaves behind what was once planned — which is the only way an auditor
-- reading the order next year can tell the difference between a plan that was always for four dates
-- and one that was for five until March.
--
-- So the two constraints widen. A date may stand WITHDRAWN as well as OPEN or BILLED, and the check
-- that ties the document to its status now says it the other way round: a billed date names the
-- document that billed it, and every other date names none.

alter table sales_billing_plan_date drop constraint if exists sales_billing_plan_date_status_ck;
alter table sales_billing_plan_date drop constraint if exists sales_billing_plan_date_billed_ck;

alter table sales_billing_plan_date
  add constraint sales_billing_plan_date_status_ck
    check (status in ('OPEN', 'BILLED', 'WITHDRAWN'));

alter table sales_billing_plan_date
  add constraint sales_billing_plan_date_billed_ck
    check ((status = 'BILLED' and billing_number is not null)
        or (status <> 'BILLED' and billing_number is null));

comment on column sales_billing_plan_date.status is
  'Where this date stands: open, billed by the document `billing_number` names, or withdrawn. A date '
  'is withdrawn rather than deleted — it answers nothing from then on and leaves behind what was once '
  'planned, because a plan is part of what was agreed about this order.';
