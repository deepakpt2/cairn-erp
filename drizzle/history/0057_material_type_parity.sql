-- SCR-048 / R-96 (stage 2): material types take the OMS2 parity shape.
--
-- The material_type table already stands from the materials build with
-- a 12-character key, a 100-character name, word price controls and
-- type-level stocked/valuated flags. Parity (R-96) reworks it in place:
-- the key narrows to four characters (the provisioned keys that break
-- the width are renamed everywhere they are carried: FINISHED to FIN,
-- TRADE to TRAD, SERVICE to SERV), the name to 25, the price-control
-- default becomes the reference letter shown as words, the contract's
-- missing fields land, account category references gain their master,
-- and quantity/value updating gains its per-plant rows (the T134M
-- shape), backfilled from the standing type flags. The type-level
-- flags retire in stage 3, when their last readers move.
alter table public.material
  drop constraint material_client_material_type_material_type_client_material_typ;
--> statement-breakpoint
update public.material
  set material_type = case material_type
    when 'FINISHED' then 'FIN' when 'TRADE' then 'TRAD' when 'SERVICE' then 'SERV'
    else material_type end
  where material_type in ('FINISHED', 'TRADE', 'SERVICE');
--> statement-breakpoint
update public.valuation_class
  set allowed_material_types = trim(both ',' from replace(replace(replace(
    ',' || allowed_material_types || ',',
    ',FINISHED,', ',FIN,'), ',TRADE,', ',TRAD,'), ',SERVICE,', ',SERV,'))
  where allowed_material_types like '%FINISHED%'
     or allowed_material_types like '%TRADE%'
     or allowed_material_types like '%SERVICE%';
--> statement-breakpoint
update public.material_type
  set material_type = case material_type
    when 'FINISHED' then 'FIN' when 'TRADE' then 'TRAD' when 'SERVICE' then 'SERV'
    else material_type end
  where material_type in ('FINISHED', 'TRADE', 'SERVICE');
--> statement-breakpoint
alter table public.material
  add constraint material_client_material_type_material_type_client_material_typ
  foreign key (client, material_type)
  references public.material_type (client, material_type);
--> statement-breakpoint
alter table public.material_type alter column material_type type varchar(4);
--> statement-breakpoint
alter table public.material_type alter column name type varchar(25);
--> statement-breakpoint
update public.material_type
  set default_price_control = case default_price_control
    when 'STANDARD' then 'S' when 'MOVING_AVERAGE' then 'V'
    else default_price_control end;
--> statement-breakpoint
alter table public.material_type alter column default_price_control type varchar(1);
--> statement-breakpoint
alter table public.material_type
  add constraint material_type_price_control_ck check (default_price_control in ('S', 'V'));
--> statement-breakpoint
alter table public.material_type add column internal_number_range varchar(2);
--> statement-breakpoint
alter table public.material_type add column external_number_range varchar(2);
--> statement-breakpoint
alter table public.material_type
  add constraint material_type_internal_range_ck
  check (internal_number_range is null or internal_number_range ~ '^[A-Z0-9]{2}$');
--> statement-breakpoint
alter table public.material_type
  add constraint material_type_external_range_ck
  check (external_number_range is null or external_number_range ~ '^[A-Z0-9]{2}$');
--> statement-breakpoint
alter table public.material_type add column external_purchase_orders char(1) not null default '2';
--> statement-breakpoint
alter table public.material_type add column internal_purchase_orders char(1) not null default '1';
--> statement-breakpoint
alter table public.material_type
  add constraint material_type_external_po_ck check (external_purchase_orders in ('0', '1', '2'));
--> statement-breakpoint
alter table public.material_type
  add constraint material_type_internal_po_ck check (internal_purchase_orders in ('0', '1', '2'));
--> statement-breakpoint
alter table public.material_type add column is_configurable boolean not null default false;
--> statement-breakpoint
create table public.account_category_reference (
  client varchar(4) not null references public.client(client) on delete cascade,
  reference varchar(4) not null,
  name varchar(40) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, reference),
  constraint account_category_reference_format_ck check (reference ~ '^[A-Z0-9]{1,4}$'),
  constraint account_category_reference_name_not_blank_ck check (length(btrim(name)) > 0)
);
--> statement-breakpoint
insert into public.account_category_reference (client, reference, name, created_by)
  select distinct client, '0001', 'General valuation', 'SYSTEM'
  from public.material_type
  on conflict do nothing;
--> statement-breakpoint
alter table public.material_type add column account_category_reference varchar(4);
--> statement-breakpoint
update public.material_type set account_category_reference = '0001'
  where account_category_reference is null;
--> statement-breakpoint
alter table public.material_type alter column account_category_reference set not null;
--> statement-breakpoint
alter table public.material_type
  add constraint material_type_account_reference_fk foreign key (client, account_category_reference)
  references public.account_category_reference (client, reference);
--> statement-breakpoint
create table public.material_type_valuation (
  client varchar(4) not null references public.client(client) on delete cascade,
  material_type varchar(4) not null,
  valuation_area varchar(10) not null,
  quantity_updating boolean not null default true,
  value_updating boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, material_type, valuation_area),
  constraint material_type_valuation_type_fk foreign key (client, material_type)
    references public.material_type (client, material_type),
  constraint material_type_valuation_plant_fk foreign key (client, valuation_area)
    references public.plant (client, plant)
);
--> statement-breakpoint
insert into public.material_type_valuation
  (client, material_type, valuation_area, quantity_updating, value_updating, created_by)
  select t.client, t.material_type, p.plant, t.is_stocked, t.is_valuated, 'SYSTEM'
  from public.material_type t
  join public.plant p on p.client = t.client
  on conflict do nothing;
