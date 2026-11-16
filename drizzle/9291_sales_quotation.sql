-- 9291_sales_quotation.sql
--
-- Sales quotation (VA21 / VA22 / VA23). Three tables of its own: a quotation consumes no availability,
-- and the promise-to-others join in availableToPromise reads sales_order_schedule through sales_order,
-- so a quotation written there would take stock from the customer who actually orders it.
--
-- Grants are select, insert, update and no DELETE. UPDATE is there for the version bump on a change and
-- for the schedule upsert; a quotation is never deleted and the promise it records is not either.

-- ── Tables ──────────────────────────────────────────────────────────────────
create table if not exists public.sales_quotation (
  client varchar(4) not null,
  quotation_number varchar(20) not null,
  document_type varchar(2) not null default 'AG',
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  division varchar(2) not null,
  customer_number varchar(40) not null,
  company_code varchar(10) not null,
  currency char(3) not null,
  quotation_date date not null,
  valid_to date not null,
  requested_date date,
  purchase_order_reference varchar(20),
  header_text varchar(100),
  status varchar(16) not null default 'OPEN',
  rejection_reason varchar(4),
  net_value numeric(23,4) not null default 0,
  tax_value numeric(23,4) not null default 0,
  gross_value numeric(23,4) not null default 0,
  version integer not null default 1,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint sales_quotation_pkey primary key (client, quotation_number),
  constraint sales_quotation_status_ck check (status in ('OPEN', 'REJECTED')),
  constraint sales_quotation_rejection_ck check (
    (status = 'REJECTED' and rejection_reason is not null) or (status = 'OPEN' and rejection_reason is null)),
  constraint sales_quotation_valid_ck check (valid_to >= quotation_date),
  constraint sales_quotation_date_ck check (requested_date is null or requested_date >= quotation_date),
  constraint sales_quotation_value_ck check (net_value >= 0 and tax_value >= 0 and gross_value >= 0),
  constraint sales_quotation_version_ck check (version > 0),
  constraint sales_quotation_type_ck check (document_type ~ '^[A-Z0-9]{2}$'),
  constraint sales_quotation_client_fk foreign key (client) references public.client (client) on delete cascade,
  constraint sales_quotation_currency_fk foreign key (currency) references public.currency (code) on delete cascade,
  constraint sales_quotation_customer_fk foreign key (client, customer_number)
    references public.business_partner (client, partner_number) on delete cascade,
  constraint sales_quotation_area_fk foreign key (client, sales_org, distribution_channel, division)
    references public.sales_area (client, sales_org, distribution_channel, division) on delete cascade,
  constraint sales_quotation_company_fk foreign key (client, company_code)
    references public.company_code (client, company_code) on delete cascade
);
create unique index if not exists sales_quotation_request_key_uq
  on public.sales_quotation (client, request_key) where request_key is not null;

create table if not exists public.sales_quotation_line (
  client varchar(4) not null,
  quotation_number varchar(20) not null,
  line_number integer not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  quotation_quantity numeric(13,3) not null,
  quantity_unit char(6) not null references public.unit_of_measure (code),
  base_quantity numeric(13,3) not null,
  confirmed_quantity numeric(13,3),
  net_price numeric(23,4) not null default 0,
  price_unit integer not null default 1,
  net_amount numeric(23,4) not null default 0,
  tax_code varchar(4),
  tax_rate numeric(7,4) not null default 0,
  tax_amount numeric(23,4) not null default 0,
  profit_center varchar(20),
  requested_delivery_date date,
  condition_number varchar(18) not null,
  status varchar(16) not null default 'OPEN',
  rejection_reason varchar(4),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint sales_quotation_line_pkey primary key (client, quotation_number, line_number),
  constraint sales_quotation_line_quantity_ck check (quotation_quantity > 0 and base_quantity > 0),
  constraint sales_quotation_line_price_ck check (net_price >= 0 and price_unit > 0 and net_amount >= 0),
  constraint sales_quotation_line_tax_ck check (tax_rate >= 0 and tax_amount >= 0),
  constraint sales_quotation_line_status_ck check (status in ('OPEN', 'REJECTED')),
  constraint sales_quotation_line_rejection_ck check (
    (status = 'REJECTED' and rejection_reason is not null) or (status = 'OPEN' and rejection_reason is null)),
  constraint sales_quotation_line_number_ck check (line_number > 0),
  constraint sales_quotation_line_header_fk foreign key (client, quotation_number)
    references public.sales_quotation (client, quotation_number) on delete cascade,
  constraint sales_quotation_line_material_fk foreign key (client, material_number)
    references public.material (client, material_number) on delete cascade
);

create table if not exists public.sales_quotation_schedule (
  client varchar(4) not null,
  quotation_number varchar(20) not null,
  quotation_line_number integer not null,
  schedule_number integer not null,
  requested_date date not null,
  requested_quantity numeric(13,3) not null,
  confirmed_quantity numeric(13,3) not null default 0,
  confirmed_date date,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint sales_quotation_schedule_pkey primary key (client, quotation_number, quotation_line_number, schedule_number),
  constraint sales_quotation_schedule_line_fk foreign key (client, quotation_number, quotation_line_number)
    references public.sales_quotation_line (client, quotation_number, line_number) on delete cascade,
  constraint sales_quotation_schedule_number_ck check (schedule_number > 0),
  constraint sales_quotation_schedule_quantity_ck check (requested_quantity > 0),
  constraint sales_quotation_schedule_confirmed_ck check (confirmed_quantity >= 0 and confirmed_quantity <= requested_quantity)
);

-- ── RLS and grants ──────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['sales_quotation','sales_quotation_line','sales_quotation_schedule'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update on table public.sales_quotation to cairn_app;
grant select, insert, update on table public.sales_quotation_line to cairn_app;
grant select, insert, update on table public.sales_quotation_schedule to cairn_app;

-- ── The orders a quotation produced are found by the reference the order carries ──
create index if not exists sales_order_reference_idx
  on public.sales_order (client, reference_document_type, reference_document_number);

-- ── The two shared category checks admit a quotation ────────────────────────
alter table public.sales_document_condition
  drop constraint if exists sales_document_condition_document_category_check;
alter table public.sales_document_condition
  add constraint sales_document_condition_document_category_check
  check (document_category in ('ORDER', 'BILLING', 'QUOTATION'));

alter table public.sales_document_partner
  drop constraint if exists sales_document_partner_category_ck;
alter table public.sales_document_partner
  add constraint sales_document_partner_category_ck
  check (document_category in ('ORDER', 'DELIVERY', 'BILLING', 'QUOTATION'));

-- ── Document type AG and its number range, for tenants that already stand ──
insert into public.sales_document_type
  (client, document_type, name, number_range_object, number_range_sub_object,
   is_active, pricing_procedure, created_by)
select t.client, 'AG', 'Quotation', 'SALESORD', 'AG', true, 'A', 'MIGRATION_9291'
  from public.sales_document_type t
 where t.document_type = 'OR'
on conflict (client, document_type) do nothing;

insert into public.number_range
  (client, object_code, sub_object, fiscal_year, prefix, from_number, to_number,
   current_number, number_length, display_style, is_buffered, buffer_size,
   is_external, status, company_code, created_by)
select r.client, 'SALESORD', 'AG', r.fiscal_year, 'SQ', r.from_number, r.to_number,
       r.from_number - 1, 7, r.display_style, false, 0, false, 'ACTIVE',
       r.company_code, 'MIGRATION_9291'
  from public.number_range r
 where r.object_code = 'SALESORD' and r.sub_object = 'OR'
on conflict (client, object_code, company_code, sub_object, fiscal_year) do nothing;

-- ── Capability, granted to no role ──────────────────────────────────────────
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('SALES.QUOTATION.CREATE', 'SALES', 'CREATE', false,
   'Create, change, display and reject a sales quotation (VA21 / VA22 / VA23), and raise a sales order from one')
on conflict (code) do nothing;

-- ── Registry and aliases ────────────────────────────────────────────────────
insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9291a000-0000-4000-8000-000000000001', 'SALES.QUOTATION.CREATE', 'sales_quotation',
       'Sales quotation', 'TRANSACTION', 'SD',
       'Create, change, display and reject a sales quotation on one screen. A quotation consumes no availability, '
       || 'creates no receivable and is judged for no credit; it is valid until the date it carries, which is computed '
       || 'when it is read and never written back. An order is raised from it at /sales/orders: the order names the '
       || 'quotation, and is priced and credit-checked on the day it is raised.',
       'TIER_1_BUILT', '/sales/quotations', 'B', null, true, 'MIGRATION_9291', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9291a000-0000-4000-8000-000000000001'
                       or r.our_code = 'SALES.QUOTATION.CREATE' or r.our_table = 'sales_quotation');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9291a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9291', now()
  from (values
    ('9291b000-0000-4000-8000-000000000001', 'VA21'),
    ('9291b000-0000-4000-8000-000000000002', 'VA22'),
    ('9291b000-0000-4000-8000-000000000003', 'VA23')
  ) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9291a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);

-- The ATP row of 9289 named module SALES; its sibling SALES.ORDER.CREATE is SD. The registry reads the
-- module for display and sorting only (src/platform/registry), so the correction changes nothing else.
update public.term_registry set module = 'SD'
 where our_code = 'SALES.ORDER.AVAILABILITY.CHECK' and module <> 'SD';
