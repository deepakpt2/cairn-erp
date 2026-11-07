-- 9224: an account assignment may name the cost object it belongs to.
--
-- An account-assigned purchase order item has never carried a real cost object. The
-- assignment row named a G/L account and a cost centre, and nothing else: an internal
-- order could not be charged at all, and an asset could only be bought the way stock is
-- bought, through goods receipt and GR/IR — which is to say, wrongly. The asset is not
-- stock. Nothing about it passes through an inventory account, and the GR/IR balance it
-- left behind was an artefact of there being no other place to put the value.
--
-- So the assignment row now names the thing the value actually belongs to:
--
--   * a cost centre, as before;
--
--   * an internal order, which the ledger has always been able to carry and the order
--     could not ask for;
--
--   * a fixed asset, with the transaction type the acquisition is posted under. The
--     type is named here rather than guessed at posting time: which acquisition a
--     line capitalizes under is a decision the buyer makes, not one a report infers
--     from whichever type happens to stand configured.
--
-- Exactly one of the three stands on a row, and the database says so — a row that named
-- both a cost centre and an asset would charge the same money twice and satisfy no
-- report. The cost centre becomes nullable because a row that charges an internal order
-- or an asset names no cost centre, and a null is the honest answer for those rows; it
-- is not a legacy value being preserved.
--
-- The item's account assignment category grows ASSET beside COST_CENTER. A service
-- category is deliberately not added: there is no service master, no service entry
-- sheet and no acceptance document in this system, and a category with nothing behind
-- it would be a promise the rest of the ledger could not keep.
--
-- No backfill: an assignment row written before this migration named a cost centre,
-- which is exactly what it still says.
alter table public.purchase_order_item
  drop constraint if exists po_item_assignment_category_ck;

alter table public.purchase_order_item
  add constraint po_item_assignment_category_ck
  check (account_assignment_category is null or account_assignment_category in ('COST_CENTER', 'ASSET'));

alter table public.purchase_order_assignment
  alter column cost_center drop not null;

alter table public.purchase_order_assignment
  add column if not exists internal_order varchar(20);

alter table public.purchase_order_assignment
  add column if not exists asset_number varchar(12);

alter table public.purchase_order_assignment
  add column if not exists asset_sub_number varchar(4);

alter table public.purchase_order_assignment
  add column if not exists asset_transaction_type varchar(4);

-- One cost object per row, and an asset named in full or not at all.
alter table public.purchase_order_assignment
  add constraint po_assignment_cost_object_ck check (
    (case when cost_center is not null then 1 else 0 end
     + case when internal_order is not null then 1 else 0 end
     + case when asset_number is not null then 1 else 0 end) = 1
  );

alter table public.purchase_order_assignment
  add constraint po_assignment_asset_ck check (
    (asset_number is null) = (asset_sub_number is null)
    and ((asset_number is null) or asset_transaction_type is not null)
  );

comment on column public.purchase_order_assignment.cost_center is
  'The cost centre this share of the value is charged to. Null where the row charges an internal order or an asset instead.';
comment on column public.purchase_order_assignment.internal_order is
  'The internal order this share of the value is charged to, where the order is the cost object.';
comment on column public.purchase_order_assignment.asset_number is
  'The fixed asset this share of the value capitalizes, where the item is account-assigned to an asset.';
comment on column public.purchase_order_assignment.asset_sub_number is
  'The asset sub-number, always named with the asset and never without it.';
comment on column public.purchase_order_assignment.asset_transaction_type is
  'The acquisition transaction type the value is capitalized under, named on the order rather than inferred at posting time.';
