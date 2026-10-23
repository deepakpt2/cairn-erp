-- KO01 internal order master. This is not a budget, a plan, a posting, or a settlement.
-- Order type IO01 is configured data. The service does not treat it as a hardcoded meaning.
-- Journal lines keep an internal-order code as text. This migration does not add a foreign key.

create table public.internal_order_type (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_type varchar(4) not null,
  description varchar(40) not null,
  number_range_sub_object varchar(10) not null default '*',
  statistical_default boolean not null default false,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_type),
  constraint internal_order_type_code_ck check (order_type ~ '^[A-Z0-9]{2,4}$'),
  constraint internal_order_type_description_ck check (char_length(btrim(description)) between 1 and 40)
);

alter table public.internal_order_type enable row level security;
alter table public.internal_order_type force row level security;
create policy tenant_isolation on public.internal_order_type
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.internal_order_type from public;
grant select, insert, update, delete on public.internal_order_type to cairn_app;

create table public.internal_order (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(20) not null,
  order_type varchar(4) not null,
  description varchar(40) not null,
  controlling_area varchar(4) not null,
  company_code varchar(10) not null,
  currency varchar(3) not null,
  start_date date not null,
  end_date date not null,
  person_responsible varchar(20),
  responsible_user varchar(40),
  cost_center varchar(10),
  profit_center varchar(10),
  statistical boolean not null default false,
  is_posting_locked boolean not null default false,
  marked_for_deletion boolean not null default false,
  source_order_number varchar(20),
  request_key varchar(64),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number),
  constraint internal_order_area_company_fk
    foreign key (client, controlling_area, company_code)
    references public.controlling_area_company (client, controlling_area, company_code),
  constraint internal_order_validity_ck check (end_date >= start_date),
  constraint internal_order_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint internal_order_description_ck check (char_length(btrim(description)) between 1 and 40),
  constraint internal_order_source_ck check (source_order_number is null or source_order_number <> order_number)
);

create unique index internal_order_request_key_uq
  on public.internal_order (client, request_key)
  where request_key is not null;

alter table public.internal_order enable row level security;
alter table public.internal_order force row level security;
create policy tenant_isolation on public.internal_order
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.internal_order from public;
grant select, insert, update, delete on public.internal_order to cairn_app;

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'INTORDER', 'Internal orders', 8, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o
    where o.client = c.client and o.object_code = 'INTORDER'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'INTORDER', '*', '*', 0, 'IO', 1, 99999999, 0, 8, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'INTORDER' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into public.internal_order_type (
  client, order_type, description, number_range_sub_object, statistical_default, created_by
)
select c.client, 'IO01', 'Internal order', '*', false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.internal_order_type t
    where t.client = c.client and t.order_type = 'IO01'
 );

insert into capability (code, module, action, is_posting_relevant, description)
values
  ('CO.ORDER.MAINTAIN', 'CO', 'CREATE', false, 'Create and change an internal order. KO01 and KO02 do not post or settle.'),
  ('CO.ORDER.DISPLAY', 'CO', 'DISPLAY', false, 'Display an internal order. KO03 writes nothing.')
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
    gen_random_uuid()::text, 'CO.ORDER.MAINTAIN', 'internal_order', 'Internal order',
    'TRANSACTION', 'CO',
    'Create or change an internal order. KO01 and KO02 are search aliases. Saving does not post, budget, or settle.',
    'TIER_1_BUILT', '/controlling/internal-orders', 'B', 'MIGRATION_9152'
  ),
  (
    gen_random_uuid()::text, 'CO.ORDER.DISPLAY', null, 'Display internal order',
    'TRANSACTION', 'CO',
    'Display an internal order. KO03 is a search alias. Display writes nothing.',
    'TIER_1_BUILT', '/controlling/internal-order-display', 'B', 'MIGRATION_9152'
  )
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9152',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9152'
from (values
  ('CO.ORDER.MAINTAIN', 'KO01'),
  ('CO.ORDER.MAINTAIN', 'KO02'),
  ('CO.ORDER.DISPLAY', 'KO03')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
