-- Add controlling_area, company_code, currency to production_order.
-- Derived from the plant's company code via the controlling area–company
-- assignment (MB03 ruling) at order creation. Nullable: existing orders
-- created before this column had no controlling area.
alter table public.production_order
  add column if not exists controlling_area varchar(4);

alter table public.production_order
  add column if not exists company_code varchar(4);

alter table public.production_order
  add column if not exists currency char(3);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'production_order_controlling_area_fk'
  ) then
    alter table public.production_order
      add constraint production_order_controlling_area_fk
      foreign key (client, controlling_area)
      references public.controlling_area (client, controlling_area);
  end if;
end $$;
