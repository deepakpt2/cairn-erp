-- SCR-138 (B-886/§26.898): production orders (CO01) — the AUFK header and its RESB
-- component list.
--
-- The MIGO 261 package opens with its own prerequisite, and it is right: a component
-- issue cannot post against an order that does not exist. This migration delivers the
-- master the next round consumes — not a second ledger for the issue itself.
--
-- The order carries no company code. Its company stands on the plant, which is where
-- the posting will read it, so a company column here would be a second copy of a fact
-- that could drift (the MB03 ruling, §26.877).
--
-- The component list is a snapshot, not a BOM explosion: canon has no BOM master, so
-- what the order states is what the order requires.

create table if not exists public.production_order (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(12) not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  order_quantity numeric(23, 3) not null,
  unit_of_measure varchar(10) not null,
  scheduled_start varchar(10) not null,
  scheduled_finish varchar(10) not null,
  status varchar(16) not null default 'CREATED',
  request_key varchar(64),
  released_by varchar(64),
  released_at timestamptz,
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint production_order_pk primary key (client, order_number),
  constraint production_order_plant_fk foreign key (client, plant)
    references public.plant (client, plant) on delete restrict,
  constraint production_order_status_ck check (status in ('CREATED', 'RELEASED')),
  constraint production_order_quantity_ck check (order_quantity > 0),
  constraint production_order_dates_ck check (scheduled_finish >= scheduled_start)
);

create table if not exists public.production_order_component (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(12) not null,
  item_number integer not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  required_quantity numeric(23, 3) not null,
  unit_of_measure varchar(10) not null,
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint production_order_component_pk primary key (client, order_number, item_number),
  constraint production_order_component_order_fk foreign key (client, order_number)
    references public.production_order (client, order_number) on delete cascade,
  constraint production_order_component_quantity_ck check (required_quantity > 0)
);

-- One request key per tenant: a resubmitted create finds the order it already made
-- rather than making a second one (the duplicate-safe discipline every posting keeps).
create unique index if not exists production_order_request_key_idx
  on public.production_order (client, request_key)
  where request_key is not null;
