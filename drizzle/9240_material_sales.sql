-- 9240: the material sales view.
--
-- DI-018 measured it and found nothing: no table, no screen, no field. A material was known to sales
-- only by its plant extension, which answers whether the warehouse can carry it and says nothing
-- about whether it may be sold, in what unit, as what kind of item, from which plant, or onto which
-- revenue account. The pricing procedure can price a line without asking any of that, because a
-- price is a price; the answers that come after the price cannot. Revenue determination reads the
-- material account assignment group from here, and the shipping-point and availability determination
-- of the next phase read the loading group and the checking group from here.
--
-- The key is SAP's MVKE key — material, sales organisation, distribution channel. The division is not
-- part of it, because in SAP the division sits on the material itself and not on its sales view.
--
-- The second part of this migration is the property worth protecting. A material that has already
-- been sold in a sales area is maintained there, from the evidence of the orders themselves: nothing
-- that can be sold this morning stops being sellable this afternoon. What the maintenance does not
-- invent is a view for a material that has never been sold — that one is maintained by hand, which is
-- what a sales view is for.

create table if not exists material_sales (
  client varchar(4) not null references client (client) on delete cascade,
  material_number varchar(40) not null,
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  -- Blank is not a missing value: it means the material is sold in its base unit.
  sales_unit varchar(6) references unit_of_measure (code),
  item_category_group varchar(4) not null default 'NORM',
  -- Blank is a key of its own and is matched as one, never as an absence.
  material_account_assignment_group varchar(4),
  delivering_plant varchar(10),
  loading_group varchar(4),
  availability_check_group varchar(4),
  sales_status varchar(16) not null default 'NOT_CREATED',
  version integer not null default 1,
  -- The audit columns every table in this package carries, in the same shape: the actor who created a
  -- row always stands, and the actor who last changed it is null until somebody changes it.
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, material_number, sales_org, distribution_channel),
  foreign key (client, material_number) references material (client, material_number) on delete cascade,
  foreign key (client, sales_org) references sales_org (client, sales_org),
  foreign key (client, distribution_channel) references distribution_channel (client, distribution_channel),
  foreign key (client, delivering_plant) references plant (client, plant),
  constraint material_sales_status_ck
    check (sales_status in ('NOT_CREATED', 'INCOMPLETE', 'CREATED', 'MAINTAINED')),
  constraint material_sales_item_category_ck check (item_category_group ~ '^[A-Z0-9]{2,4}$')
);

create index if not exists material_sales_plant_idx on material_sales (client, delivering_plant);
create index if not exists material_sales_group_idx
  on material_sales (client, material_account_assignment_group);

-- The view is per tenant, as every material view is. Grants are SELECT, INSERT and UPDATE and no
-- DELETE: a material that has been sold in a sales area carries orders behind it, and its view is
-- withdrawn by a maintainer, not erased.
alter table material_sales enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['material_sales']
  loop
    execute format('drop policy if exists %I on %I', table_name || '_tenant', table_name);
    execute format(
      'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      table_name || '_tenant', table_name
    );
    execute format('revoke all on table %I from public', table_name);
    execute format('grant select, insert, update on table %I to cairn_app', table_name);
  end loop;
end $$;

-- Every material that has been sold is maintained where it was sold, from the evidence of the orders
-- that sold it. The item category group is the standard one and the delivering plant is the plant the
-- orders shipped from: the two things the view says that the orders already proved.
insert into material_sales (
  client, material_number, sales_org, distribution_channel,
  item_category_group, delivering_plant, sales_status, created_by, changed_by
)
select distinct o.client, l.material_number, o.sales_org, o.distribution_channel,
       'NORM', min(l.plant) over (partition by o.client, l.material_number, o.sales_org, o.distribution_channel),
       'CREATED', 'MIGRATION_9240', 'MIGRATION_9240'
  from sales_order_line l
  join sales_order o
    on o.client = l.client and o.order_number = l.order_number
 where l.status = 'OPEN'
on conflict (client, material_number, sales_org, distribution_channel) do nothing;

-- A sales area that stands with no view for the materials it has sold would refuse business that was
-- written before the view existed, which is the one thing this must not do. The rows above are the
-- evidence; where a material has no row and no history, it is maintained by hand.

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SD.MATERIAL.SALES.MAINTAIN', 'SALES', 'MAINTAIN', false,
  'Maintain the sales view of a material at /inventory/materials: the unit it is sold in, the item category it becomes on an order, the account assignment group revenue is determined by, the plant it ships from, and the loading and availability-check groups the shipping point and the availability check read. It creates no document and posts nothing.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
values (
  'SD.MATERIAL.SALES.MAINTAIN',
  'SALES_AND_DISTRIBUTION',
  null,
  'Maintain the material sales view',
  'DEFINE',
  'CFG.SALES.PRICING.DEFINE',
  'Where a material may be sold, in what unit, as what kind of item and onto which revenue account. A material with no view in a sales area cannot be sold there.',
  994,
  'STANDARD',
  '/inventory/materials',
  false,
  'MIGRATION_9240'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9240',
  changed_at = now();
