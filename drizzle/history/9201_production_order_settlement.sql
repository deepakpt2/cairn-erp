-- PROD.ORDER.SETTLE — production-order settlement (KO88 equivalent for production orders).
-- No settlement profile, distribution rule, allocation structure, receiver, percentage,
-- or settlement account is stored here. Neither transaction posts until those exist.
-- WIP calculation (DV-003) and variance categorization (DV-004) remain deferred.
-- CO88, CJ88, KO8B, KO9E are not this run.

-- Production order type -> settlement profile mapping. Like internal_order_type_settlement_profile
-- but for production orders. The profile assignment, the allocation assignment and the distribution
-- rule are one condition: a settlement posts only when all three agree on where the balance goes.
create table public.production_order_type_settlement_profile (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_type varchar(4) not null,
  profile_code varchar(6) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_type),
  constraint production_order_type_settlement_profile_type_fk
    foreign key (client, order_type)
    references public.production_order_type (client, order_type),
  constraint production_order_type_settlement_profile_profile_fk
    foreign key (client, profile_code)
    references public.settlement_profile (client, profile_code)
);

-- Distribution rule for one production order. A receiver is stored here, never assumed.
-- Mirrors settlement_distribution_rule but keys on production_order instead of internal_order.
create table public.production_order_settlement_distribution_rule (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(12) not null,
  rule_number smallint not null,
  receiver_category varchar(16) not null,
  receiver varchar(20) not null,
  percentage numeric(7, 4),
  equivalence numeric(10, 0),
  amount numeric(23, 4),
  settlement_type varchar(3) not null,
  valid_from_year integer not null,
  valid_from_period smallint not null,
  valid_to_year integer not null,
  valid_to_period smallint not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number, rule_number),
  constraint production_order_settlement_distribution_rule_order_fk
    foreign key (client, order_number)
    references public.production_order (client, order_number),
  constraint production_order_settlement_distribution_rule_category_ck
    check (receiver_category in ('COST_CENTER', 'INTERNAL_ORDER', 'GL_ACCOUNT')),
  constraint production_order_settlement_distribution_rule_type_ck
    check (settlement_type in ('PER', 'FUL')),
  constraint production_order_settlement_distribution_rule_share_ck
    check (num_nonnulls(percentage, equivalence, amount) = 1),
  constraint production_order_settlement_distribution_rule_percentage_ck
    check (percentage is null or (percentage > 0 and percentage <= 100)),
  constraint production_order_settlement_distribution_rule_equivalence_ck
    check (equivalence is null or equivalence > 0),
  constraint production_order_settlement_distribution_rule_amount_ck
    check (amount is null or amount > 0)
);

-- Row-level security on the new tables, matching the existing settlement tables.
do $$
declare
  target text;
begin
  foreach target in array array[
    'production_order_type_settlement_profile',
    'production_order_settlement_distribution_rule'
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

-- Register the production-order settlement capability.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'PROD.ORDER.SETTLE', 'PROD', 'CREATE', false,
  'KO88 equivalent for one production order. Settles actual costs collected on the order to configured receivers. Does not post until a settlement rule is stored, and none is configured.'
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
  gen_random_uuid()::text, 'PROD.ORDER.SETTLE', null, 'Production order settlement',
  'TRANSACTION', 'PROD',
  'Settle one production order. PROD.ORDER.SETTLE is a search alias. No receiver or percentage is assumed. An update does not post while no settlement rule is configured. WIP calculation (DV-003) and variance categorization (DV-004) are deferred.',
  'TIER_1_BUILT', '/production/order-settlement', 'B', 'MIGRATION_9201'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9201',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9201'
from (values
  ('PROD.ORDER.SETTLE', 'KO88')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
