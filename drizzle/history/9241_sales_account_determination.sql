-- 9241: revenue is determined, not chosen.
--
-- An invoice was posted to one revenue account and one tax account, both read from the account
-- determination that belongs to inventory and purchasing. That table answers "what is this posting
-- worth", which is a question about a material and a movement; it cannot answer the question a sale
-- asks, which is about a customer, a material, a sales organisation and the kind of figure being
-- posted. A discount is not revenue, freight is not the price of the goods, and output tax is not
-- anybody's revenue — and the only place that distinction is written down is the account key the
-- pricing step carries.
--
-- So three things stand after this migration. The customer carries an account assignment group, as
-- the material's new sales view already does. A determination table keyed on chart of accounts, sales
-- organisation, the two groups and the account key names the account, most specific first. And where
-- no row stands, the document is not posted: an invoice whose revenue account nobody chose is a number
-- in the ledger with no rule behind it.
--
-- The customer's group is added to a table that already stands, so the column is nullable and the
-- rows that stand keep the blank they have always had — which is matched as a group of its own, not
-- as a value nobody set. No customer moves.

alter table customer_sales_area add column if not exists account_assignment_group varchar(4);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_sales_account_group'
  ) then
    alter table customer_sales_area add constraint customer_sales_account_group
      check (account_assignment_group is null or account_assignment_group ~ '^[A-Z0-9]{1,4}$');
  end if;
end $$;

create table if not exists sales_account_determination (
  client varchar(4) not null references client (client) on delete cascade,
  chart_of_accounts varchar(4) not null,
  -- Blank in the three parts below means "any". It is a value that is matched, never an absence.
  sales_org varchar(4) not null default '',
  customer_account_assignment_group varchar(4) not null default '',
  material_account_assignment_group varchar(4) not null default '',
  account_key varchar(4) not null,
  gl_account varchar(10) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (
    client, chart_of_accounts, sales_org, customer_account_assignment_group,
    material_account_assignment_group, account_key
  ),
  foreign key (client, chart_of_accounts) references chart_of_accounts (client, chart_of_accounts) on delete restrict,
  -- The account is unique per chart, so the chart is part of the reference: a determination may only
  -- name an account the chart it is maintained for actually holds.
  foreign key (client, chart_of_accounts, gl_account)
    references gl_account (client, chart_of_accounts, account_number) on delete restrict,
  constraint sales_account_determination_key_ck check (account_key ~ '^[A-Z0-9]{2,4}$')
);

-- The tenant policy and the grants, as every configuration table carries them: SELECT, INSERT and
-- UPDATE and no DELETE, because a row here is part of the rule an invoice was posted under.
alter table sales_account_determination enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_account_determination']
  loop
    execute format('drop policy if exists %I on %I', table_name || '_tenant', table_name);
    execute format(
      'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      table_name || '_tenant', table_name
    );
    execute format('revoke all on table %I from public', table_name);
    execute format('grant select, insert, update on table %I to cairn_app', table_name);
  end loop;
end $$;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.ACCOUNT_DETERMINATION.DEFINE', 'SALES', 'CONFIGURE', false,
  'Define revenue account determination at /config/sales-account-determination: which G/L account a sale posts to, keyed on the chart of accounts, the sales organisation, the account assignment group of the customer, the account assignment group of the material and the account key of the pricing step. The most specific row that fits answers, and where none stands no invoice is posted. It creates no document and posts nothing.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
values (
  'CFG.SALES.ACCOUNT_DETERMINATION.DEFINE',
  'SALES_AND_DISTRIBUTION',
  null,
  'Assign revenue accounts',
  'DEFINE',
  'CFG.SALES.PRICING.DEFINE',
  'Which G/L account each part of a sale posts to: the price, a discount, freight and output tax. Where no account is determined for a key, the invoice is refused rather than posted somewhere plausible.',
  996,
  'STANDARD',
  '/config/sales-account-determination',
  true,
  'MIGRATION_9241'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9241',
  changed_at = now();
