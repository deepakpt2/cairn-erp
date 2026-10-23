-- ME31K purchase contract. A contract is not a purchase order and does not post stock or accounting.
-- Document types are configured rows. MK and WK are seeded names, not service constants.
-- Call-off is a purchase-order item reference. A draft is not a status this ERP stores.

create table public.purchasing_contract_type (
  client varchar(4) not null references public.client (client) on delete cascade,
  document_type varchar(4) not null,
  description varchar(40) not null,
  category varchar(10) not null,
  number_range_sub_object varchar(10) not null default '*',
  item_interval integer not null default 10,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_type),
  constraint purchasing_contract_type_code_ck check (document_type ~ '^[A-Z0-9]{2,4}$'),
  constraint purchasing_contract_type_category_ck check (category in ('QUANTITY', 'VALUE')),
  constraint purchasing_contract_type_interval_ck check (item_interval > 0),
  constraint purchasing_contract_type_description_ck check (char_length(btrim(description)) between 1 and 40)
);

alter table public.purchasing_contract_type enable row level security;
alter table public.purchasing_contract_type force row level security;
create policy tenant_isolation on public.purchasing_contract_type
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_contract_type from public;
grant select, insert, update, delete on public.purchasing_contract_type to cairn_app;

create table public.purchase_contract (
  client varchar(4) not null references public.client (client) on delete cascade,
  contract_number varchar(20) not null,
  document_type varchar(4) not null,
  category varchar(10) not null,
  supplier_number varchar(40) not null,
  purchasing_org varchar(10) not null,
  purchasing_group varchar(3) not null,
  company_code varchar(10) not null,
  currency varchar(3) not null,
  agreement_date date not null,
  validity_start date not null,
  validity_end date not null,
  target_value numeric(15, 2),
  payment_terms_code varchar(12),
  incoterms_code varchar(3),
  incoterms_location varchar(160),
  your_reference varchar(12),
  our_reference varchar(12),
  language_code varchar(2),
  source_contract_number varchar(20),
  request_key varchar(64),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, contract_number),
  constraint purchase_contract_category_ck check (category in ('QUANTITY', 'VALUE')),
  constraint purchase_contract_value_ck check (
    (category = 'VALUE' and target_value is not null and target_value > 0)
    or (category = 'QUANTITY' and (target_value is null or target_value >= 0))
  ),
  constraint purchase_contract_validity_ck check (validity_end >= validity_start),
  constraint purchase_contract_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint purchase_contract_incoterms_ck check (
    incoterms_code is null or incoterms_code in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')
  ),
  constraint purchase_contract_source_ck check (
    source_contract_number is null or source_contract_number <> contract_number
  )
);

create unique index purchase_contract_request_key_uq
  on public.purchase_contract (client, request_key)
  where request_key is not null;

alter table public.purchase_contract enable row level security;
alter table public.purchase_contract force row level security;
create policy tenant_isolation on public.purchase_contract
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchase_contract from public;
grant select, insert, update, delete on public.purchase_contract to cairn_app;

create table public.purchase_contract_item (
  client varchar(4) not null,
  contract_number varchar(20) not null,
  item_number integer not null,
  item_category varchar(16) not null default 'STANDARD',
  account_assignment_category varchar(16),
  material_number varchar(40),
  short_text varchar(40) not null,
  target_quantity numeric(13, 3),
  unit varchar(6),
  net_price numeric(11, 2) not null default 0,
  price_unit numeric(5, 0) not null default 1,
  net_value numeric(15, 2) not null default 0,
  plant varchar(10),
  storage_location varchar(10),
  material_group varchar(9),
  cost_center varchar(10),
  gl_account varchar(10),
  requisition_number varchar(10),
  requisition_item integer,
  rfq_number varchar(20),
  rfq_item integer,
  quotation_number varchar(20),
  quotation_item integer,
  info_record_number varchar(20),
  price_sequence integer,
  marked_for_deletion boolean not null default false,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, contract_number, item_number),
  constraint purchase_contract_item_header_fk
    foreign key (client, contract_number) references public.purchase_contract (client, contract_number),
  constraint purchase_contract_item_category_ck check (item_category = 'STANDARD'),
  constraint purchase_contract_item_assignment_ck check (
    account_assignment_category is null or account_assignment_category = 'COST_CENTER'
  ),
  constraint purchase_contract_item_number_ck check (item_number > 0),
  constraint purchase_contract_item_quantity_ck check (target_quantity is null or target_quantity > 0),
  constraint purchase_contract_item_price_ck check (net_price >= 0 and price_unit > 0),
  constraint purchase_contract_item_text_ck check (char_length(btrim(short_text)) between 1 and 40),
  constraint purchase_contract_item_plant_ck check (plant is null or char_length(btrim(plant)) > 0),
  constraint purchase_contract_item_location_ck check (
    storage_location is null or plant is not null
  ),
  constraint purchase_contract_item_assignment_pair_ck check (
    (account_assignment_category is null and cost_center is null and gl_account is null)
    or (account_assignment_category = 'COST_CENTER' and cost_center is not null and gl_account is not null)
  ),
  constraint purchase_contract_item_requisition_pair_ck check (
    (requisition_number is null) = (requisition_item is null)
  ),
  constraint purchase_contract_item_rfq_pair_ck check ((rfq_number is null) = (rfq_item is null)),
  constraint purchase_contract_item_quotation_pair_ck check (
    (quotation_number is null) = (quotation_item is null)
  )
);

create index purchase_contract_item_material_idx
  on public.purchase_contract_item (client, material_number);

alter table public.purchase_contract_item enable row level security;
alter table public.purchase_contract_item force row level security;
create policy tenant_isolation on public.purchase_contract_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchase_contract_item from public;
grant select, insert, update, delete on public.purchase_contract_item to cairn_app;

alter table public.purchase_order_item
  add column if not exists contract_number varchar(20),
  add column if not exists contract_item integer;

alter table public.purchase_order_item
  drop constraint if exists purchase_order_item_contract_pair_ck;
alter table public.purchase_order_item
  add constraint purchase_order_item_contract_pair_ck
  check ((contract_number is null) = (contract_item is null));

alter table public.purchase_order_item
  drop constraint if exists purchase_order_item_contract_fk;
alter table public.purchase_order_item
  add constraint purchase_order_item_contract_fk
  foreign key (client, contract_number, contract_item)
  references public.purchase_contract_item (client, contract_number, item_number);

create index if not exists purchase_order_item_contract_idx
  on public.purchase_order_item (client, contract_number, contract_item);

alter table public.document_release drop constraint document_release_category_ck;
alter table public.document_release add constraint document_release_category_ck
  check (document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT'));

alter table public.release_group drop constraint release_group_category_ck;
alter table public.release_group add constraint release_group_category_ck
  check (document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT'));

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'PURCHCONT', 'Purchase contracts', 10, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o
    where o.client = c.client and o.object_code = 'PURCHCONT'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'PURCHCONT', '*', '*', 0, '46', 1, 999999, 0, 10, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'PURCHCONT' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into public.purchasing_contract_type (
  client, document_type, description, category, number_range_sub_object, item_interval, created_by
)
select c.client, 'MK', 'Quantity contract', 'QUANTITY', '*', 10, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.purchasing_contract_type t
    where t.client = c.client and t.document_type = 'MK'
 );

insert into public.purchasing_contract_type (
  client, document_type, description, category, number_range_sub_object, item_interval, created_by
)
select c.client, 'WK', 'Value contract', 'VALUE', '*', 10, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.purchasing_contract_type t
    where t.client = c.client and t.document_type = 'WK'
 );

insert into capability (code, module, action, is_posting_relevant, description)
values
  ('PROC.CONTRACT.MAINTAIN', 'PROC', 'CREATE', false, 'Create and change a purchase contract. ME31K and ME32K do not post stock or accounting.'),
  ('PROC.CONTRACT.DISPLAY', 'PROC', 'DISPLAY', false, 'Display a purchase contract. ME33K writes nothing.'),
  ('PROC.CONTRACT.RELEASE', 'PROC', 'APPROVE', false, 'Release a purchase contract when a strategy claims it. ME35K is not a universal approval threshold.'),
  ('PROC.CONTRACT.LIST', 'PROC', 'DISPLAY', false, 'List outline agreements. ME3N reads contracts. It does not post.')
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- A role holding PROC.* receives these capabilities without a new grant.
insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values
  (
    gen_random_uuid()::text, 'PROC.CONTRACT.MAINTAIN', 'purchase_contract', 'Purchase contract',
    'TRANSACTION', 'PROC',
    'Create or change a quantity or value contract. ME31K and ME32K are search aliases. Saving does not post stock, a goods receipt, or accounting.',
    'TIER_1_BUILT', '/purchasing/contracts', 'B', 'MIGRATION_9147'
  ),
  (
    gen_random_uuid()::text, 'PROC.CONTRACT.DISPLAY', null, 'Display purchase contract',
    'TRANSACTION', 'PROC',
    'Display a purchase contract. ME33K is a search alias. Display writes nothing.',
    'TIER_1_BUILT', '/purchasing/contracts', 'B', 'MIGRATION_9147'
  ),
  (
    gen_random_uuid()::text, 'PROC.CONTRACT.RELEASE', null, 'Release purchase contract',
    'TRANSACTION', 'PROC',
    'Release a contract when a strategy claims it. ME35K is a search alias. No strategy means no release is required.',
    'TIER_1_BUILT', '/purchasing/contracts', 'B', 'MIGRATION_9147'
  ),
  (
    gen_random_uuid()::text, 'PROC.CONTRACT.LIST', null, 'Outline agreements',
    'TRANSACTION', 'PROC',
    'List contracts with target, called-off, and remaining quantity or value. ME3N is a search alias. The list does not post.',
    'TIER_1_BUILT', '/purchasing/contracts', 'B', 'MIGRATION_9147'
  )
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9147',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9147'
from (values
  ('PROC.CONTRACT.MAINTAIN', 'ME31K'),
  ('PROC.CONTRACT.MAINTAIN', 'ME32K'),
  ('PROC.CONTRACT.DISPLAY', 'ME33K'),
  ('PROC.CONTRACT.RELEASE', 'ME35K'),
  ('PROC.CONTRACT.LIST', 'ME3N')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
