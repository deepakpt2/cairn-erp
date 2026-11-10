-- 9247: how much of an order may go out at once.
--
-- The customer master has carried three delivery promises for as long as it has existed in this
-- package, and the order and the delivery have read none of them. That is the gap §3.4 closes: a
-- field a screen maintains and no document honours is worse than no field, because it looks like a
-- promise being kept.
--
-- Two of the three are already there. `complete_delivery` (KNVV-AUTLF) says the whole order travels
-- in one delivery, and `order_combination` says this customer's orders may be gathered into one. What
-- is missing is the item-level pair SAP carries beside them:
--
--   KNVV-KZTLF, the partial delivery indicator. Blank leaves the item free to go out in pieces; 'C'
--   says an item is delivered complete or not at all. It is an answer about the item, not about the
--   order, and it is the one a warehouse actually feels: two boxes today and three on Thursday is a
--   different piece of work from one pallet on Friday.
--
--   KNVV-ANTLF, the maximum number of partial deliveries. How many times this item may be split
--   before the rest has to travel together. Zero is a customer who has said nothing about it, and
--   zero means no limit — not "no partial deliveries", which is what 'C' is for. A limit of zero
--   would be a customer who can never be served.
--
-- Both default to the value that binds nobody, because a tenant that has never opened this screen has
-- made no promise, and a default that refuses deliveries is not a default anybody asked for.

alter table customer_sales_area add column if not exists partial_delivery_indicator varchar(1) not null default '';
alter table customer_sales_area add column if not exists max_partial_deliveries smallint not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_sales_partial_delivery_ck') then
    alter table customer_sales_area add constraint customer_sales_partial_delivery_ck
      check (partial_delivery_indicator in ('', 'C'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customer_sales_max_partial_ck') then
    alter table customer_sales_area add constraint customer_sales_max_partial_ck
      check (max_partial_deliveries between 0 and 9);
  end if;
end $$;

comment on column customer_sales_area.partial_delivery_indicator is
  'KNVV-KZTLF. How much of an item may go out at once: blank leaves it free to travel in pieces, C '
  'says an item is delivered complete or not at all. It is a rule about the item, where the '
  'complete-delivery flag beside it is a rule about the order.';

comment on column customer_sales_area.max_partial_deliveries is
  'KNVV-ANTLF. How many times an item may be split across deliveries before the rest has to travel '
  'together. Zero is a customer who has said nothing about it, and it is read as no limit: a limit '
  'of zero would be a customer who can never be served, which is what the partial delivery indicator '
  'C is for.';

comment on column customer_sales_area.complete_delivery is
  'KNVV-AUTLF. The whole order travels in one delivery, or in none: a delivery that leaves any open '
  'item behind is refused. Honoured from this migration; it was maintained and ignored before it.';

comment on column customer_sales_area.order_combination is
  'Whether this customer''s orders may be gathered into one delivery. Honoured from this migration; '
  'it was maintained and ignored before it.';
