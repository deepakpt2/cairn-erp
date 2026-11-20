-- 9317_order_type_wip_method.sql
-- Financial WIP is opt-in per production order type: '' (the default) = no WIP, 'ACTUAL_COST_NET_BALANCE' = the
-- limited actual-cost method of order-wip.ts. Maintained on the existing production-order-type screen.
alter table public.production_order_type
  add column if not exists wip_method varchar(24) not null default '';
alter table public.production_order_type drop constraint if exists production_order_type_wip_method_ck;
alter table public.production_order_type add constraint production_order_type_wip_method_ck
  check (wip_method in ('', 'ACTUAL_COST_NET_BALANCE'));
