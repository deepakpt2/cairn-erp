-- 9225: an internal order is an account assignment category of its own.
--
-- Until now an internal order was filed under COST_CENTER: the category said "this
-- value is consumed", and the row quietly carried an internal order in the column
-- that used to be the only spare one. That was a convenience, and it leaked. A cost
-- centre and an internal order are different objects with different masters,
-- different validity, different locks and different reports, and a row that says
-- COST_CENTER while naming an order makes every reader choose which of the two to
-- believe. The invoice judge had to look at both columns to work out what a row
-- meant, and ME2K had to guess whether 'K' included the rows that name orders.
--
-- So the order gets its own category, after SAP's own convention:
--
--   * COST_CENTER (K) names a cost centre, and nothing else;
--   * ORDER (F) names an internal order, and nothing else;
--   * ASSET (A) names a fixed asset, and nothing else.
--
-- Each category carries the object it names and is validated on that object's own
-- terms — a cost centre against its validity and posting lock, an internal order
-- against its validity, lock and controlling area, an asset against its class and
-- the acquisition type. None of them is treated as another wearing a different hat.
--
-- The category is on the item and the object is on the row, so the pairing is held
-- by a trigger rather than a check constraint: a check cannot see across the two
-- tables. The trigger refuses a row whose object contradicts its item's category,
-- and refuses an item whose category contradicts the rows beneath it.
--
-- Rows already standing are moved, not grandfathered: an item that charges an
-- internal order was filed under COST_CENTER because there was nowhere else to file
-- it, and it now says what it is. Nothing else about those rows changes.
--
-- No project or WBS category is added. There is no project master, no WBS element
-- master and no journal column for either, so a category naming one would point at
-- nothing and could not be validated, posted or reported. It remains a documented
-- gap, to be built as part of a properly designed project accounting capability.
--
-- No service category is added, for the same reason and with the same consequences:
-- there is no service master, no service entry sheet and no acceptance document.

alter table public.purchase_order_item
  drop constraint if exists po_item_assignment_category_ck;

alter table public.purchase_order_item
  add constraint po_item_assignment_category_ck
  check (account_assignment_category is null
         or account_assignment_category in ('COST_CENTER', 'ORDER', 'ASSET'));

-- An item that charges an internal order becomes an ORDER item.
update public.purchase_order_item i
   set account_assignment_category = 'ORDER',
       changed_at = now()
 where i.account_assignment_category = 'COST_CENTER'
   and exists (
     select 1 from public.purchase_order_assignment a
      where a.client = i.client
        and a.order_number = i.order_number
        and a.item_number = i.item_number
        and a.internal_order is not null
   );

comment on column public.purchase_order_assignment.internal_order is
  'The internal order this share of the value is charged to. Set only where the item is account-assigned to an internal order (category ORDER).';
comment on column public.purchase_order_assignment.cost_center is
  'The cost centre this share of the value is charged to. Set only where the item is account-assigned to a cost centre (category COST_CENTER).';

-- The category names one object; the row must carry that object and no other.
create or replace function public.purchase_order_assignment_category_object()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_category varchar(20);
begin
  select i.account_assignment_category
    into v_category
    from public.purchase_order_item i
   where i.client = new.client
     and i.order_number = new.order_number
     and i.item_number = new.item_number;

  if v_category is null then
    raise exception
      'Item % of order % carries no account assignment category, so this row has no object to name.',
      new.item_number, new.order_number
      using errcode = '23514';
  end if;

  if v_category = 'COST_CENTER' and (new.cost_center is null or new.internal_order is not null or new.asset_number is not null) then
    raise exception
      'Item % of order % is assigned to a cost centre (K), so this row must name a cost centre and no other object.',
      new.item_number, new.order_number
      using errcode = '23514';
  elsif v_category = 'ORDER' and (new.internal_order is null or new.cost_center is not null or new.asset_number is not null) then
    raise exception
      'Item % of order % is assigned to an internal order (F), so this row must name an internal order and no other object.',
      new.item_number, new.order_number
      using errcode = '23514';
  elsif v_category = 'ASSET' and (new.asset_number is null or new.cost_center is not null or new.internal_order is not null) then
    raise exception
      'Item % of order % is assigned to an asset (A), so this row must name an asset and no other object.',
      new.item_number, new.order_number
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.purchase_order_assignment_category_object() from public;
grant execute on function public.purchase_order_assignment_category_object() to cairn_app;

-- Changing the category under rows that name another object leaves the order
-- contradicting itself, so the rows are re-checked when the change is committed.
-- Deferred, because an item's category and the rows beneath it are not rewritten
-- together: the buyer's change replaces the rows after it re-categorises the item,
-- and a check that ran in the middle of that would refuse a change that ends correct.
create or replace function public.purchase_order_item_category_recheck()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.account_assignment_category is not distinct from old.account_assignment_category then
    return new;
  end if;
  -- The row-level trigger performs the judgement; this only asks it to run.
  update public.purchase_order_assignment a
     set changed_at = a.changed_at
   where a.client = new.client
     and a.order_number = new.order_number
     and a.item_number = new.item_number;
  return new;
end;
$$;

revoke all on function public.purchase_order_item_category_recheck() from public;
grant execute on function public.purchase_order_item_category_recheck() to cairn_app;

drop trigger if exists purchase_order_assignment_category_object_trg on public.purchase_order_assignment;
create trigger purchase_order_assignment_category_object_trg
  before insert or update on public.purchase_order_assignment
  for each row execute function public.purchase_order_assignment_category_object();

drop trigger if exists purchase_order_item_category_recheck_trg on public.purchase_order_item;
create constraint trigger purchase_order_item_category_recheck_trg
  after update of account_assignment_category on public.purchase_order_item
  deferrable initially deferred
  for each row execute function public.purchase_order_item_category_recheck();
