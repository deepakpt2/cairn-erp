-- 9245: where the goods leave from.
--
-- A delivery has always named the plant it loads from, and nothing else. That is one half of the
-- answer a warehouse needs. The other half is the dock: the place inside that plant where the goods
-- are picked, loaded and handed to a carrier, with its own working times and its own way of doing
-- things. SAP calls it the shipping point, and it is not entered by the person raising the delivery —
-- it is derived, from three things the documents and the masters already carry.
--
-- Those three are the shipping condition of the customer the goods are going to, the loading group of
-- the material being sent, and the delivering plant. The condition is the customer's requirement: how
-- fast, by what kind of carrier, under what arrangement. The loading group is the material's: what it
-- takes to get it onto a vehicle, which is a question about cranes and bay sizes and the time it
-- takes, and not about anybody's urgency. The plant is where the stock stands. Together they name a
-- shipping point, through a table the tenant maintains — SAP's OVL2, and behind it TVSTZ.
--
-- The table is a determination, so it is built the way the other determinations in this package are
-- built: rows, blank as a value that is matched, most specific first. A row naming the condition and
-- the group answers before a row naming only one of them, and a row naming neither is the plant's own
-- answer for everything it has no opinion about. Where the loading group and the shipping condition
-- both have something to say and no row says both, the material's group stands: a shipping point that
-- cannot lift the goods is no answer at all, whereas a customer who wants it fast can be served from
-- anywhere that can load it.
--
-- Nothing is seeded. A plant nobody has configured has no shipping point, and a delivery raised
-- against it is refused rather than raised without one — which is what SAP's incompletion log exists
-- to catch, and what this package says in the only voice it has until that log stands.

create table if not exists shipping_condition (
  client varchar(4) not null references client (client) on delete cascade,
  shipping_condition varchar(2) not null,
  description varchar(40) not null default '',
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, shipping_condition),
  constraint shipping_condition_code_ck check (shipping_condition ~ '^[A-Z0-9]{1,2}$')
);

comment on table shipping_condition is
  'How a customer wants goods to reach them (SAP VSBED, maintained in the customer master shipping '
  'view). With the material''s loading group and the delivering plant it names the shipping point. '
  'It is a requirement of the customer, not of the material: the same goods go by road for one '
  'customer and by air for another.';

create table if not exists shipping_point (
  client varchar(4) not null references client (client) on delete cascade,
  shipping_point varchar(4) not null,
  name varchar(40) not null default '',
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, shipping_point),
  constraint shipping_point_code_ck check (shipping_point ~ '^[A-Z0-9]{1,4}$')
);

comment on table shipping_point is
  'The place a delivery is loaded (SAP VSTEL / TVST): a dock, a depot, a gate. It carries no plant of '
  'its own — which plant it loads from is answered by each row that assigns it, the way OVXC assigns '
  'one, and a single point may load for several plants.';

create table if not exists shipping_point_determination (
  client varchar(4) not null references client (client) on delete cascade,
  delivering_plant varchar(10) not null,
  -- Blank is a value and is matched as one: it is the answer for a customer maintained with no
  -- condition, or a material maintained with no loading group. It is never a gap to be filled in.
  shipping_condition varchar(2) not null default '',
  loading_group varchar(4) not null default '',
  shipping_point varchar(4) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, delivering_plant, shipping_condition, loading_group),
  foreign key (client, delivering_plant) references plant (client, plant) on delete restrict,
  foreign key (client, shipping_point) references shipping_point (client, shipping_point) on delete restrict,
  constraint shipping_point_determination_condition_ck
    check (shipping_condition = '' or shipping_condition ~ '^[A-Z0-9]{1,2}$'),
  constraint shipping_point_determination_group_ck
    check (loading_group = '' or loading_group ~ '^[A-Z0-9]{1,4}$')
);

comment on table shipping_point_determination is
  'Shipping condition + loading group + delivering plant to the shipping point that loads them (SAP '
  'OVL2 / TVSTZ). The most specific row that fits answers; blank is matched as a value, so the row '
  'naming neither condition nor group is the plant''s own answer for everything it has no opinion '
  'about. Where no row fits, the delivery is refused and names this table rather than being raised '
  'with no dock to load from.';

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. Which dock a delivery loads from is part of what the delivery was.
alter table shipping_condition enable row level security;
alter table shipping_point enable row level security;
alter table shipping_point_determination enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['shipping_condition', 'shipping_point', 'shipping_point_determination']
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

-- The customer's half of the determination: what the ship-to has asked for, maintained on the sales
-- area the order was raised in. Null is a customer who has said nothing, and it is matched by the
-- rows that name no condition — never filled in with a guess.
alter table customer_sales_area add column if not exists shipping_condition varchar(2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_sales_area_shipping_condition_fk') then
    alter table customer_sales_area add constraint customer_sales_area_shipping_condition_fk
      foreign key (client, shipping_condition) references shipping_condition (client, shipping_condition)
      on delete restrict;
  end if;
end $$;

comment on column customer_sales_area.shipping_condition is
  'KNVV-VSBED. How this customer wants goods to reach them, and the customer''s half of shipping '
  'point determination. Null is a customer who has said nothing: those are answered by the '
  'determination rows that name no condition.';

-- What the delivery carries. The shipping point is null on a delivery raised before the determination
-- stood, and those read as they always did.
alter table delivery add column if not exists shipping_point varchar(4);
alter table delivery add column if not exists ship_to_name varchar(160) not null default '';
alter table delivery add column if not exists ship_to_street varchar(180);
alter table delivery add column if not exists ship_to_city varchar(100);
alter table delivery add column if not exists ship_to_region varchar(80);
alter table delivery add column if not exists ship_to_postal_code varchar(20);
alter table delivery add column if not exists ship_to_country char(2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delivery_shipping_point_fk') then
    alter table delivery add constraint delivery_shipping_point_fk
      foreign key (client, shipping_point) references shipping_point (client, shipping_point)
      on delete restrict;
  end if;
end $$;

comment on column delivery.shipping_point is
  'The dock this delivery loads from, determined when it was created from the ship-to''s shipping '
  'condition, the material''s loading group and the delivering plant. Null on a delivery raised '
  'before the determination stood.';

comment on column delivery.ship_to_name is
  'Where the goods went. A delivery carries the address it was raised with, not the one that '
  'customer''s master carries now: remaking a customer next month must not rewrite where last '
  'month''s goods were delivered.';

-- Every delivery that stood is given the address it was raised with: the ship-to named on the
-- delivery, or on its order, or the sold-to on its header when neither carries one — the same
-- fallback the delivery is read by.
update delivery d
   set ship_to_name = bp.name,
       ship_to_street = bp.street,
       ship_to_city = bp.city,
       ship_to_region = bp.region,
       ship_to_postal_code = bp.postal_code,
       ship_to_country = bp.country
  from business_partner bp
 where bp.client = d.client
   and bp.partner_number = coalesce(
         (select p.partner_number from sales_document_partner p
           where p.client = d.client and p.document_category = 'DELIVERY'
             and p.document_number = d.delivery_number and p.function_code = 'SH'),
         (select p.partner_number from sales_document_partner p
           where p.client = d.client and p.document_category = 'ORDER'
             and p.document_number = d.order_number and p.function_code = 'SH'),
         d.customer_number);
