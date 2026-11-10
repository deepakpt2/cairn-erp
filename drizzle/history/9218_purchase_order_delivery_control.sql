-- 9218: ME21N item delivery control, part one — tolerances, delivery completion,
-- and the goods-receipt indicator.
--
-- A purchase order item has always been received against the tolerance the material
-- carries at its plant. That is the wrong place for the decision: the tolerance is a
-- term agreed with a supplier for an order, so a buyer must be able to state it on the
-- order and see what the order will accept. Today the buyer can neither see nor change
-- it, and the underdelivery tolerance is carried on the material and read by nothing at
-- all. Nor can an item be closed: an order stays open until its quantity happens to be
-- met, so a supplier who ships 96 of 100 leaves a balance open forever.
--
-- This is the first of two parts. Part one is tolerances, delivery completion and the
-- goods-receipt indicator — none of which move money. Part two adds the invoice side:
-- the GR-based invoice-verification switch, invoicing before a receipt, and vendor
-- advances, which do.
--
-- Three things are stored, and all three are mandatory:
--
--   * overdelivery and underdelivery tolerance, as a snapshot. The order does not fall
--     back to a master at posting time. When the item is written the module resolves the
--     figure once — a buyer's override first, then the material at its plant, then the
--     purchasing info record, then zero — and stores what it resolved. What was agreed
--     on the order is what the order enforces, even if a master moves afterwards.
--
--   * unlimited overdelivery, which removes the ceiling. It is false unless it is
--     explicitly set, because it lets a receipt — and therefore spend — run past the
--     quantity a release strategy approved.
--
--   * delivery completed, which closes the item, and the goods-receipt indicator, which
--     says the item receives goods at all. Both are new gates in the goods receipt.
--
-- Whether a receipt closes an item by itself is a policy, not a property: some plants
-- want the balance closed once a delivery lands inside the underdelivery tolerance,
-- others want a buyer to decide every time. So the rule is configuration, held as a
-- company-code default with a plant override — a plant row wins, and a plant with no
-- row inherits its company. Nothing is seeded: with no row the answer is no, an item
-- closes when someone says so, which is how the application behaves today.
--
-- The tolerances are stored on the purchasing info record as well, so a standing
-- agreement with a supplier can state them and an order can inherit them.

alter table public.purchase_order_item
  add column if not exists overdelivery_tolerance numeric(5,2) not null default 0,
  add column if not exists underdelivery_tolerance numeric(5,2) not null default 0,
  add column if not exists unlimited_overdelivery boolean not null default false,
  add column if not exists delivery_completed boolean not null default false,
  add column if not exists goods_receipt_indicator boolean not null default true;

alter table public.purchase_order_item
  add constraint purchase_order_item_tolerance_ck
  check (overdelivery_tolerance between 0 and 100 and underdelivery_tolerance between 0 and 100);

alter table public.purchasing_info_record_org
  add column if not exists overdelivery_tolerance numeric(5,2) not null default 0,
  add column if not exists underdelivery_tolerance numeric(5,2) not null default 0;

alter table public.purchasing_info_record_org
  add constraint purchasing_info_record_org_tolerance_ck
  check (overdelivery_tolerance between 0 and 100 and underdelivery_tolerance between 0 and 100);

-- Items that already stand: the material at its plant is the only source that has ever
-- carried a tolerance, so it is the whole resolution for existing rows.
update public.purchase_order_item poi
   set overdelivery_tolerance = mp.overdelivery_tolerance,
       underdelivery_tolerance = mp.underdelivery_tolerance
  from public.material_plant mp
 where mp.client = poi.client
   and mp.material_number = poi.material_number
   and mp.plant = poi.plant;

create table if not exists public.purchase_delivery_completion_policy (
  client                varchar(4)  not null,
  company_code          varchar(4)  not null,
  auto_close            boolean     not null default false,
  version               integer     not null default 1,
  last_request_key      varchar(64),
  created_by            varchar(40) not null,
  created_at            timestamptz not null default now(),
  changed_by            varchar(40) not null,
  changed_at            timestamptz not null default now(),
  constraint purchase_delivery_completion_policy_pk
    primary key (client, company_code),
  constraint purchase_delivery_completion_policy_version_ck
    check (version > 0)
);

create table if not exists public.purchase_delivery_completion_plant (
  client                varchar(4)  not null,
  plant                 varchar(10) not null,
  auto_close            boolean     not null,
  version               integer     not null default 1,
  last_request_key      varchar(64),
  created_by            varchar(40) not null,
  created_at            timestamptz not null default now(),
  changed_by            varchar(40) not null,
  changed_at            timestamptz not null default now(),
  constraint purchase_delivery_completion_plant_pk
    primary key (client, plant),
  constraint purchase_delivery_completion_plant_version_ck
    check (version > 0)
);

comment on table public.purchase_delivery_completion_policy is
  'The company-code default for closing a purchase order item by a goods receipt.';
comment on table public.purchase_delivery_completion_plant is
  'The plant override for closing a purchase order item by a goods receipt. A plant with no row inherits its company code.';

-- Row-level security on the two new tables.
do $$
declare
  target text;
begin
  foreach target in array array[
    'purchase_delivery_completion_policy',
    'purchase_delivery_completion_plant'
  ]
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);
    execute format(
      'create policy tenant_isolation on public.%I using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      target
    );
    execute format('revoke all on public.%I from public', target);
    execute format('grant select, insert, update, delete on public.%I to cairn_app', target);
  end loop;
end $$;
