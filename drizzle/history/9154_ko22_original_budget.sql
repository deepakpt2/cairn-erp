-- KO22 changes the original budget of an internal order. KO23 displays it.
-- A save writes a budget document. It does not post, supplement, return, or settle.
-- BP01 is configured data. The service does not treat it as a hardcoded meaning.
-- Availability control is stored and not executed. No tolerance is seeded.

create table public.internal_order_budget_profile (
  client varchar(4) not null references public.client (client) on delete cascade,
  profile_code varchar(6) not null,
  description varchar(40) not null,
  overall_budget boolean not null,
  annual_budget boolean not null,
  annual_not_exceed_overall boolean not null default false,
  availability_control boolean not null default false,
  change_allowed boolean not null default true,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, profile_code),
  constraint internal_order_budget_profile_code_ck check (profile_code ~ '^[A-Z0-9]{2,6}$'),
  constraint internal_order_budget_profile_scope_ck check (overall_budget or annual_budget),
  constraint internal_order_budget_profile_description_ck check (char_length(btrim(description)) between 1 and 40)
);

alter table public.internal_order_budget_profile enable row level security;
alter table public.internal_order_budget_profile force row level security;
create policy tenant_isolation on public.internal_order_budget_profile
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.internal_order_budget_profile from public;
grant select, insert, update, delete on public.internal_order_budget_profile to cairn_app;

create table public.internal_order_type_budget_profile (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_type varchar(4) not null,
  profile_code varchar(6) not null,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_type),
  constraint internal_order_type_budget_profile_profile_fk
    foreign key (client, profile_code)
    references public.internal_order_budget_profile (client, profile_code)
);

alter table public.internal_order_type_budget_profile enable row level security;
alter table public.internal_order_type_budget_profile force row level security;
create policy tenant_isolation on public.internal_order_type_budget_profile
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.internal_order_type_budget_profile from public;
grant select, insert, update, delete on public.internal_order_type_budget_profile to cairn_app;

create table public.internal_order_original_budget (
  client varchar(4) not null references public.client (client) on delete cascade,
  document_number varchar(20) not null,
  order_number varchar(20) not null,
  document_date date not null,
  fiscal_year integer not null,
  period smallint not null,
  currency varchar(3) not null,
  overall_amount numeric(23, 4),
  document_text varchar(50),
  request_key varchar(64),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_number),
  constraint internal_order_original_budget_order_fk
    foreign key (client, order_number)
    references public.internal_order (client, order_number) on delete cascade,
  constraint internal_order_original_budget_amount_ck check (overall_amount is null or overall_amount >= 0),
  constraint internal_order_original_budget_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint internal_order_original_budget_period_ck check (period between 1 and 16)
);

create unique index internal_order_original_budget_request_key_uq
  on public.internal_order_original_budget (client, request_key)
  where request_key is not null;

alter table public.internal_order_original_budget enable row level security;
alter table public.internal_order_original_budget force row level security;
create policy tenant_isolation on public.internal_order_original_budget
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.internal_order_original_budget from public;
grant select, insert, update, delete on public.internal_order_original_budget to cairn_app;

create table public.internal_order_original_budget_year (
  client varchar(4) not null references public.client (client) on delete cascade,
  document_number varchar(20) not null,
  fiscal_year integer not null,
  amount numeric(23, 4) not null,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_number, fiscal_year),
  constraint internal_order_original_budget_year_document_fk
    foreign key (client, document_number)
    references public.internal_order_original_budget (client, document_number) on delete cascade,
  constraint internal_order_original_budget_year_amount_ck check (amount >= 0)
);

alter table public.internal_order_original_budget_year enable row level security;
alter table public.internal_order_original_budget_year force row level security;
create policy tenant_isolation on public.internal_order_original_budget_year
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.internal_order_original_budget_year from public;
grant select, insert, update, delete on public.internal_order_original_budget_year to cairn_app;

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'ORDBUDGET', 'Original budgets', 8, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o
    where o.client = c.client and o.object_code = 'ORDBUDGET'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'ORDBUDGET', '*', '*', 0, 'OB', 1, 99999999, 0, 8, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'ORDBUDGET' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into public.internal_order_budget_profile (
  client, profile_code, description, overall_budget, annual_budget,
  annual_not_exceed_overall, availability_control, change_allowed, created_by
)
select c.client, 'BP01', 'Original budget', true, true, true, false, true, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.internal_order_budget_profile p
    where p.client = c.client and p.profile_code = 'BP01'
 );

insert into public.internal_order_type_budget_profile (client, order_type, profile_code, created_by)
select t.client, t.order_type, 'BP01', 'SYSTEM'
  from public.internal_order_type t
 where t.order_type = 'IO01'
   and not exists (
     select 1 from public.internal_order_type_budget_profile a
      where a.client = t.client and a.order_type = t.order_type
   );

insert into capability (code, module, action, is_posting_relevant, description)
values
  ('CO.BUDGET.ORIGINAL.CHANGE', 'CO', 'CREATE', false, 'Change the original budget of an internal order. KO22 does not post, supplement, or settle.'),
  ('CO.BUDGET.ORIGINAL.DISPLAY', 'CO', 'DISPLAY', false, 'Display the original budget of an internal order. KO23 writes nothing.')
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
    gen_random_uuid()::text, 'CO.BUDGET.ORIGINAL.CHANGE', 'internal_order_original_budget', 'Original budget',
    'TRANSACTION', 'CO',
    'Change the original budget of an internal order. KO22 is a search alias. Saving does not post, supplement, return, or settle.',
    'TIER_1_BUILT', '/controlling/original-budget', 'B', 'MIGRATION_9154'
  ),
  (
    gen_random_uuid()::text, 'CO.BUDGET.ORIGINAL.DISPLAY', null, 'Display original budget',
    'TRANSACTION', 'CO',
    'Display the original budget of an internal order. KO23 is a search alias. Display writes nothing.',
    'TIER_1_BUILT', '/controlling/original-budget-display', 'B', 'MIGRATION_9154'
  )
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9154',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9154'
from (values
  ('CO.BUDGET.ORIGINAL.CHANGE', 'KO22'),
  ('CO.BUDGET.ORIGINAL.DISPLAY', 'KO23')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
