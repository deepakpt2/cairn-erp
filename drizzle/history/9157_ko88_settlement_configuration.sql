-- KO88 posts only when a settlement profile, an allocation assignment, and a
-- distribution rule are already stored. This migration does not seed a
-- receiver, a percentage, a document type, or an account. KO8B is not registered.

create table public.allocation_structure (
  client varchar(4) not null references public.client (client) on delete cascade,
  structure_code varchar(6) not null,
  description varchar(40) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, structure_code),
  constraint allocation_structure_code_ck check (structure_code ~ '^[A-Z0-9]{2,6}$')
);

create table public.allocation_structure_assignment (
  client varchar(4) not null references public.client (client) on delete cascade,
  structure_code varchar(6) not null,
  source_account varchar(10) not null,
  receiver_category varchar(16) not null,
  by_original_account boolean not null,
  settlement_account varchar(10),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, structure_code, source_account, receiver_category),
  constraint allocation_structure_assignment_structure_fk
    foreign key (client, structure_code)
    references public.allocation_structure (client, structure_code),
  constraint allocation_structure_assignment_category_ck
    check (receiver_category in ('COST_CENTER', 'INTERNAL_ORDER', 'GL_ACCOUNT')),
  constraint allocation_structure_assignment_account_ck check (
    (by_original_account = true and settlement_account is null)
    or (by_original_account = false and settlement_account is not null)
  )
);

create table public.settlement_profile (
  client varchar(4) not null references public.client (client) on delete cascade,
  profile_code varchar(6) not null,
  description varchar(40) not null,
  allocation_structure varchar(6) not null,
  document_type varchar(12) not null,
  percentage_allowed boolean not null,
  equivalence_allowed boolean not null,
  amount_allowed boolean not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, profile_code),
  constraint settlement_profile_code_ck check (profile_code ~ '^[A-Z0-9]{2,6}$'),
  constraint settlement_profile_method_ck check (percentage_allowed or equivalence_allowed or amount_allowed),
  constraint settlement_profile_structure_fk
    foreign key (client, allocation_structure)
    references public.allocation_structure (client, structure_code),
  constraint settlement_profile_document_type_fk
    foreign key (client, document_type)
    references public.document_type (client, document_type)
);

create table public.internal_order_type_settlement_profile (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_type varchar(4) not null,
  profile_code varchar(6) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_type),
  constraint internal_order_type_settlement_profile_type_fk
    foreign key (client, order_type)
    references public.internal_order_type (client, order_type),
  constraint internal_order_type_settlement_profile_profile_fk
    foreign key (client, profile_code)
    references public.settlement_profile (client, profile_code)
);

create table public.settlement_distribution_rule (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(20) not null,
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
  constraint settlement_distribution_rule_order_fk
    foreign key (client, order_number)
    references public.internal_order (client, order_number),
  constraint settlement_distribution_rule_category_ck
    check (receiver_category in ('COST_CENTER', 'INTERNAL_ORDER', 'GL_ACCOUNT')),
  constraint settlement_distribution_rule_type_ck check (settlement_type in ('PER', 'FUL')),
  constraint settlement_distribution_rule_share_ck
    check (num_nonnulls(percentage, equivalence, amount) = 1),
  constraint settlement_distribution_rule_percentage_ck
    check (percentage is null or (percentage > 0 and percentage <= 100)),
  constraint settlement_distribution_rule_equivalence_ck
    check (equivalence is null or equivalence > 0),
  constraint settlement_distribution_rule_amount_ck
    check (amount is null or amount > 0)
);

create table public.settlement_document (
  client varchar(4) not null references public.client (client) on delete cascade,
  document_number varchar(40) not null,
  fiscal_year integer not null,
  order_number varchar(20) not null,
  settlement_period smallint not null,
  currency varchar(3) not null,
  amount numeric(23, 4) not null,
  request_key varchar(80),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_number, fiscal_year),
  constraint settlement_document_amount_ck check (amount > 0),
  constraint settlement_document_journal_fk
    foreign key (client, document_number, fiscal_year)
    references public.journal_entry (client, document_number, fiscal_year)
);

create unique index settlement_document_request_key_uq
  on public.settlement_document (client, request_key)
  where request_key is not null;

create index settlement_document_order_idx
  on public.settlement_document (client, order_number);

do $$
declare
  target text;
begin
  foreach target in array array[
    'allocation_structure',
    'allocation_structure_assignment',
    'settlement_profile',
    'internal_order_type_settlement_profile',
    'settlement_distribution_rule',
    'settlement_document'
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

update capability
   set is_posting_relevant = true,
       description = 'KO88 actual settlement for one internal order. An update posts through the journal service only when a settlement rule is stored.'
 where code = 'CO.SETTLE.ORDER';

update capability
   set is_posting_relevant = true,
       description = 'KO8G actual settlement for a selection of internal orders. It uses the same settlement check as KO88 and posts only when a rule is stored.'
 where code = 'CO.SETTLE.COLLECTIVE';

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CO.SETTLE.RULE', 'CO', 'CREATE', false,
  'Store a settlement profile assignment, an allocation assignment, and a distribution rule. Saving does not post.'
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
  gen_random_uuid()::text, 'CO.SETTLE.RULE', 'settlement_distribution_rule', 'Settlement rule',
  'TRANSACTION', 'CO',
  'Store the settlement rule an order settlement reads. Saving does not post. This screen has no SAP transaction code. KO02 and KO8B are not this screen.',
  'TIER_1_BUILT', '/controlling/settlement-rules', 'B', 'MIGRATION_9157'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9157',
  changed_at = now();

update term_registry
   set description = 'Settle one internal order. KO88 is a search alias. An update posts only when a distribution rule is stored. A receiver is not assumed.',
       changed_by = 'MIGRATION_9157',
       changed_at = now()
 where our_code = 'CO.SETTLE.ORDER';

update term_registry
   set description = 'Settle a selection of internal orders. KO8G is a search alias. It calls the same settlement as KO88. A receiver is not assumed.',
       changed_by = 'MIGRATION_9157',
       changed_at = now()
 where our_code = 'CO.SETTLE.COLLECTIVE';
