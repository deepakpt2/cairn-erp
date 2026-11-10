-- ME31L scheduling agreement. This is not a purchase contract and not a purchase order.
-- Document type LP is configured data. The service does not treat LP as a hardcoded meaning.
-- ME31L does not create a delivery schedule line. ME38 is not this migration.

create table public.scheduling_agreement_type (
  client varchar(4) not null references public.client (client) on delete cascade,
  document_type varchar(4) not null,
  description varchar(40) not null,
  category varchar(12) not null,
  number_range_sub_object varchar(10) not null default '*',
  item_interval integer not null default 10,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_type),
  constraint scheduling_agreement_type_code_ck check (document_type ~ '^[A-Z0-9]{2,4}$'),
  constraint scheduling_agreement_type_category_ck check (category = 'SCHEDULING'),
  constraint scheduling_agreement_type_interval_ck check (item_interval > 0),
  constraint scheduling_agreement_type_description_ck check (char_length(btrim(description)) between 1 and 40)
);

alter table public.scheduling_agreement_type enable row level security;
alter table public.scheduling_agreement_type force row level security;
create policy tenant_isolation on public.scheduling_agreement_type
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_agreement_type from public;
grant select, insert, update, delete on public.scheduling_agreement_type to cairn_app;

create table public.scheduling_agreement (
  client varchar(4) not null references public.client (client) on delete cascade,
  agreement_number varchar(20) not null,
  document_type varchar(4) not null,
  supplier_number varchar(40) not null,
  purchasing_org varchar(10) not null,
  purchasing_group varchar(3) not null,
  company_code varchar(10) not null,
  currency varchar(3) not null,
  agreement_date date not null,
  validity_start date not null,
  validity_end date not null,
  payment_terms_code varchar(12),
  incoterms_code varchar(3),
  incoterms_location varchar(160),
  your_reference varchar(12),
  our_reference varchar(12),
  request_key varchar(64),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, agreement_number),
  constraint scheduling_agreement_validity_ck check (validity_end >= validity_start),
  constraint scheduling_agreement_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint scheduling_agreement_incoterms_ck check (
    incoterms_code is null or incoterms_code in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')
  )
);

create unique index scheduling_agreement_request_key_uq
  on public.scheduling_agreement (client, request_key)
  where request_key is not null;

alter table public.scheduling_agreement enable row level security;
alter table public.scheduling_agreement force row level security;
create policy tenant_isolation on public.scheduling_agreement
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_agreement from public;
grant select, insert, update, delete on public.scheduling_agreement to cairn_app;

create table public.scheduling_agreement_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  agreement_number varchar(20) not null,
  item_number integer not null,
  item_category varchar(16) not null default 'STANDARD',
  account_assignment_category varchar(16),
  material_number varchar(40),
  short_text varchar(40) not null,
  target_quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  net_price numeric(11, 2) not null,
  price_unit numeric(5, 0) not null default 1,
  net_value numeric(15, 2) not null,
  plant varchar(10),
  storage_location varchar(10),
  cost_center varchar(10),
  gl_account varchar(10),
  requisition_number varchar(10),
  requisition_item integer,
  info_record_number varchar(20),
  price_sequence integer,
  marked_for_deletion boolean not null default false,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, agreement_number, item_number),
  constraint scheduling_agreement_item_header_fk
    foreign key (client, agreement_number)
    references public.scheduling_agreement (client, agreement_number) on delete cascade,
  constraint scheduling_agreement_item_category_ck check (item_category = 'STANDARD'),
  constraint scheduling_agreement_item_assignment_ck check (
    account_assignment_category is null or account_assignment_category = 'COST_CENTER'
  ),
  constraint scheduling_agreement_item_quantity_ck check (target_quantity > 0),
  constraint scheduling_agreement_item_price_ck check (net_price >= 0 and price_unit > 0),
  constraint scheduling_agreement_item_requisition_ck check (
    (requisition_number is null) = (requisition_item is null)
  )
);

alter table public.scheduling_agreement_item enable row level security;
alter table public.scheduling_agreement_item force row level security;
create policy tenant_isolation on public.scheduling_agreement_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_agreement_item from public;
grant select, insert, update, delete on public.scheduling_agreement_item to cairn_app;

create table public.scheduling_agreement_schedule_line (
  client varchar(4) not null references public.client (client) on delete cascade,
  agreement_number varchar(20) not null,
  item_number integer not null,
  line_number integer not null,
  delivery_date date not null,
  quantity numeric(13, 3) not null,
  unit varchar(6),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, agreement_number, item_number, line_number),
  constraint scheduling_agreement_schedule_line_item_fk
    foreign key (client, agreement_number, item_number)
    references public.scheduling_agreement_item (client, agreement_number, item_number) on delete cascade,
  constraint scheduling_agreement_schedule_line_quantity_ck check (quantity > 0),
  constraint scheduling_agreement_schedule_line_number_ck check (line_number > 0)
);

alter table public.scheduling_agreement_schedule_line enable row level security;
alter table public.scheduling_agreement_schedule_line force row level security;
create policy tenant_isolation on public.scheduling_agreement_schedule_line
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_agreement_schedule_line from public;
grant select, insert, update, delete on public.scheduling_agreement_schedule_line to cairn_app;

alter table public.document_release drop constraint document_release_category_ck;
alter table public.document_release add constraint document_release_category_ck
  check (document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT', 'SCHED_AGREEMENT'));

alter table public.release_group drop constraint release_group_category_ck;
alter table public.release_group add constraint release_group_category_ck
  check (document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT', 'SCHED_AGREEMENT'));

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'SCHEDAGREE', 'Scheduling agreements', 10, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o
    where o.client = c.client and o.object_code = 'SCHEDAGREE'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'SCHEDAGREE', '*', '*', 0, '55', 1, 999999, 0, 10, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'SCHEDAGREE' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into public.scheduling_agreement_type (
  client, document_type, description, category, number_range_sub_object, item_interval, created_by
)
select c.client, 'LP', 'Scheduling agreement', 'SCHEDULING', '*', 10, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.scheduling_agreement_type t
    where t.client = c.client and t.document_type = 'LP'
 );

insert into capability (code, module, action, is_posting_relevant, description)
values
  ('PROC.SCHEDAGREE.MAINTAIN', 'PROC', 'CREATE', false, 'Create and change a scheduling agreement. ME31L and ME32L do not post stock or accounting.'),
  ('PROC.SCHEDAGREE.DISPLAY', 'PROC', 'DISPLAY', false, 'Display a scheduling agreement. ME33L writes nothing.'),
  ('PROC.SCHEDAGREE.RELEASE', 'PROC', 'APPROVE', false, 'Release a scheduling agreement when a strategy claims it. ME35L is not a universal approval threshold.'),
  ('PROC.SCHEDAGREE.LIST', 'PROC', 'DISPLAY', false, 'List scheduling agreements. ME3L reads them. It does not post.')
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values
  (
    gen_random_uuid()::text, 'PROC.SCHEDAGREE.MAINTAIN', 'scheduling_agreement', 'Scheduling agreement',
    'TRANSACTION', 'PROC',
    'Create or change a scheduling agreement. ME31L and ME32L are search aliases. Saving does not create a delivery schedule, a purchase order, a goods receipt, or accounting.',
    'TIER_1_BUILT', '/purchasing/scheduling-agreements', 'B', 'MIGRATION_9150'
  ),
  (
    gen_random_uuid()::text, 'PROC.SCHEDAGREE.DISPLAY', null, 'Display scheduling agreement',
    'TRANSACTION', 'PROC',
    'Display a scheduling agreement. ME33L is a search alias. Display writes nothing.',
    'TIER_1_BUILT', '/purchasing/scheduling-agreement-display', 'B', 'MIGRATION_9150'
  ),
  (
    gen_random_uuid()::text, 'PROC.SCHEDAGREE.RELEASE', null, 'Release scheduling agreement',
    'TRANSACTION', 'PROC',
    'Release a scheduling agreement when a strategy claims it. ME35L is a search alias. No strategy means no release is required.',
    'TIER_1_BUILT', '/purchasing/scheduling-agreements', 'B', 'MIGRATION_9150'
  ),
  (
    gen_random_uuid()::text, 'PROC.SCHEDAGREE.LIST', null, 'Scheduling agreements',
    'TRANSACTION', 'PROC',
    'List scheduling agreements. ME3L is a search alias. The list does not post.',
    'TIER_1_BUILT', '/purchasing/scheduling-agreements', 'B', 'MIGRATION_9150'
  )
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9150',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9150'
from (values
  ('PROC.SCHEDAGREE.MAINTAIN', 'ME31L'),
  ('PROC.SCHEDAGREE.MAINTAIN', 'ME32L'),
  ('PROC.SCHEDAGREE.DISPLAY', 'ME33L'),
  ('PROC.SCHEDAGREE.RELEASE', 'ME35L'),
  ('PROC.SCHEDAGREE.LIST', 'ME3L')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
