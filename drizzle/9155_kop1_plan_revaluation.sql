-- KOP1 creates a plan-revaluation definition for internal orders.
-- Saving it does not change plan amounts, budgets, or journals.
-- No percentage is stored. KOPU is not this migration.
-- KOP2, KOP3, and KOP4 are not registered here.

create table public.plan_revaluation_order (
  client varchar(4) not null references public.client (client) on delete cascade,
  revaluation_number varchar(20) not null,
  controlling_area varchar(4) not null,
  fiscal_year integer not null,
  period_from smallint not null,
  period_to smallint not null,
  plan_version varchar(3) not null,
  description varchar(40) not null,
  currency varchar(3) not null,
  execution_status varchar(16) not null default 'NOT_EXECUTED',
  request_key varchar(64),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, revaluation_number),
  constraint plan_revaluation_order_area_fk
    foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area),
  constraint plan_revaluation_order_year_ck check (fiscal_year between 1000 and 9999),
  constraint plan_revaluation_order_period_ck check (
    period_from between 1 and 16 and period_to between 1 and 16 and period_to >= period_from
  ),
  constraint plan_revaluation_order_version_ck check (plan_version ~ '^[A-Z0-9]{1,3}$'),
  constraint plan_revaluation_order_status_ck check (execution_status = 'NOT_EXECUTED'),
  constraint plan_revaluation_order_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint plan_revaluation_order_description_ck check (char_length(btrim(description)) between 1 and 40)
);

create unique index plan_revaluation_order_request_key_uq
  on public.plan_revaluation_order (client, request_key)
  where request_key is not null;

alter table public.plan_revaluation_order enable row level security;
alter table public.plan_revaluation_order force row level security;
create policy tenant_isolation on public.plan_revaluation_order
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.plan_revaluation_order from public;
grant select, insert, update, delete on public.plan_revaluation_order to cairn_app;

create table public.plan_revaluation_order_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  revaluation_number varchar(20) not null,
  order_number varchar(20) not null,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, revaluation_number, order_number),
  constraint plan_revaluation_order_item_header_fk
    foreign key (client, revaluation_number)
    references public.plan_revaluation_order (client, revaluation_number) on delete cascade
);

alter table public.plan_revaluation_order_item enable row level security;
alter table public.plan_revaluation_order_item force row level security;
create policy tenant_isolation on public.plan_revaluation_order_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.plan_revaluation_order_item from public;
grant select, insert, update, delete on public.plan_revaluation_order_item to cairn_app;

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'REVALORD', 'Plan revaluation orders', 8, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o
    where o.client = c.client and o.object_code = 'REVALORD'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'REVALORD', '*', '*', 0, 'RV', 1, 99999999, 0, 8, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'REVALORD' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CO.PLANREVAL.CREATE', 'CO', 'CREATE', false,
  'Create a plan-revaluation definition for internal orders. KOP1 does not revalue plan data.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text, 'CO.PLANREVAL.CREATE', 'plan_revaluation_order', 'Plan revaluation',
  'TRANSACTION', 'CO',
  'Create a plan-revaluation definition for internal orders. KOP1 is a search alias. Saving does not change plan amounts. KOPU is not this screen.',
  'TIER_1_BUILT', '/controlling/plan-revaluation', 'B', 'MIGRATION_9155'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9155',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'KOP1', 'SEARCH_ONLY', 'MIGRATION_9155'
  from term_registry t
 where t.our_code = 'CO.PLANREVAL.CREATE'
on conflict (external_system, alias) do nothing;
