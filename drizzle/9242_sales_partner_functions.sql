-- 9242: who the sale is with.
--
-- A sale is made with one customer and answered by up to four. The sold-to orders; the ship-to
-- receives; the bill-to is where the invoice is addressed; the payer is who owes the money. Until
-- now the order header's single customer number was all four of them at once, which is why a
-- receivable can only ever name the company that placed the order — and a group that buys through a
-- subsidiary, ships to a site, and pays from a head office cannot be written down at all.
--
-- So three things stand after this migration. A catalogue of the four functions, which is delivered
-- with the package and is not extended: what a function means is what the code does with it, and a
-- fifth function would be a row that answered nothing. A customer master that names who plays each
-- function, maintained for a sales area or for all of them, where the row that names the area stands
-- over the row that names none — blank is a value that is matched, as it is in revenue
-- determination, not a hole in the configuration. And a document that carries the partners it was
-- made with, so an invoice raised in March still says who it was addressed to after that customer's
-- master is changed in June.
--
-- The sold-to is never assigned: it is the customer whose master this is. Assigning it would be a
-- second answer to a question the row already answers, so the table refuses it.

create table if not exists sales_partner_function (
  client varchar(4) not null references client (client) on delete cascade,
  function_code varchar(4) not null,
  display_name varchar(80) not null,
  meaning varchar(240) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, function_code),
  constraint sales_partner_function_code_ck check (function_code in ('SP', 'SH', 'BP', 'PY'))
);

comment on table sales_partner_function is
  'The four partner functions a sale is made with (SAP PARVW): what each one is for, in words, so no '
  'screen and no report has to guess at SP and PY. Delivered with the package and not extended, '
  'because what a function means is what the code does with it.';

create table if not exists customer_sales_partner (
  client varchar(4) not null references client (client) on delete cascade,
  -- The customer whose master this row belongs to: the sold-to.
  partner_number varchar(40) not null,
  -- Blank in the three parts below means "any", as it does in revenue determination. A row maintained
  -- for one sales area stands over the row maintained for all of them, and the row that names no area
  -- is what answers for a customer nobody has refined.
  sales_org varchar(4) not null default '',
  distribution_channel varchar(4) not null default '',
  division varchar(4) not null default '',
  function_code varchar(4) not null,
  assigned_partner_number varchar(40) not null,
  partner_role_code varchar(16) not null default 'CUSTOMER',
  assigned_role_code varchar(16) not null default 'CUSTOMER',
  is_active boolean not null default true,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, partner_number, sales_org, distribution_channel, division, function_code),
  foreign key (client, function_code)
    references sales_partner_function (client, function_code) on delete restrict,
  -- Both sides are customers: a ship-to that is not a customer cannot receive a delivery, and a payer
  -- that is not a customer has no reconciliation account for the receivable to be posted to.
  foreign key (client, partner_number, partner_role_code)
    references bp_role (client, partner_number, role_code) on delete cascade,
  foreign key (client, assigned_partner_number, assigned_role_code)
    references bp_role (client, partner_number, role_code) on delete restrict,
  constraint customer_sales_partner_role_ck
    check (partner_role_code = 'CUSTOMER' and assigned_role_code = 'CUSTOMER'),
  -- The sold-to is not assigned. It is the customer the row hangs off, and a second answer to a
  -- question the row already answers is a contradiction waiting to be read the wrong way.
  constraint customer_sales_partner_function_ck check (function_code <> 'SP'),
  constraint customer_sales_partner_area_ck check (
    (sales_org = '' or sales_org ~ '^[A-Z0-9]{1,4}$')
    and (distribution_channel = '' or distribution_channel ~ '^[A-Z0-9]{1,4}$')
    and (division = '' or division ~ '^[A-Z0-9]{1,4}$')
  ),
  constraint customer_sales_partner_version_ck check (version > 0)
);

comment on table customer_sales_partner is
  'Who plays each partner function for a customer (SAP KNVP), maintained for one sales area or for all '
  'of them. The most specific row that fits answers; a function nobody maintains falls back to the one '
  'above it — the payer to the bill-to, and the ship-to and the bill-to to the sold-to.';

create table if not exists sales_document_partner (
  client varchar(4) not null references client (client) on delete cascade,
  document_category varchar(16) not null,
  document_number varchar(20) not null,
  function_code varchar(4) not null,
  partner_number varchar(40) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, document_category, document_number, function_code),
  foreign key (client, function_code)
    references sales_partner_function (client, function_code) on delete restrict,
  foreign key (client, partner_number)
    references business_partner (client, partner_number) on delete restrict,
  constraint sales_document_partner_category_ck
    check (document_category in ('ORDER', 'DELIVERY', 'BILLING'))
);

comment on table sales_document_partner is
  'The partners a document was made with (SAP VBPA): the order carries all four, the delivery carries '
  'the ship-to it ships to, and the billing document carries the bill-to it is addressed to and the '
  'payer whose receivable it raises. Written at creation and never re-derived, so a document read in '
  'a year still names the customers it was made with.';

-- The four functions, for every tenant that stands. The names are what a screen and an audit read;
-- the meanings are what a maintainer reads when deciding who to put in the row.
insert into sales_partner_function (client, function_code, display_name, meaning, created_by)
select c.client, v.function_code, v.display_name, v.meaning, 'MIGRATION_9242'
  from client c
  cross join (values
    ('SP', 'Sold-to party',
     'The customer the order is made with. It is the customer whose master the sale is written against, and it is never assigned to itself.'),
    ('SH', 'Ship-to party',
     'Where the goods go. The delivery is raised for it and takes its address from it, and it defaults to the sold-to.'),
    ('BP', 'Bill-to party',
     'Who the invoice is addressed to. It defaults to the sold-to, and the payer defaults to it.'),
    ('PY', 'Payer',
     'Who owes the money. The receivable is posted against it and it is the account that is settled, so it is the customer the ageing and the open items are read for; it defaults to the bill-to.')
  ) as v(function_code, display_name, meaning)
on conflict (client, function_code) do nothing;

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. A partner a document was made with is evidence of what the document was, and
-- a function a customer plays is part of the rule an invoice was posted under.
alter table sales_partner_function enable row level security;
alter table customer_sales_partner enable row level security;
alter table sales_document_partner enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'sales_partner_function', 'customer_sales_partner', 'sales_document_partner'
  ]
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
  'CFG.SALES.PARTNER.DEFINE', 'SALES', 'CONFIGURE', false,
  'Assign partner functions to a customer at /foundation/partners: who ships to, who is billed to and who pays for the sales made with that customer. The most specific row that fits answers, and a function nobody maintains falls back to the one above it — the payer to the bill-to, everything else to the sold-to. It creates no document and posts nothing.'
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
  'CFG.SALES.PARTNER.DEFINE',
  'SALES_AND_DISTRIBUTION',
  null,
  'Assign partner functions',
  'DEFINE',
  'CFG.SALES.ACCOUNT_DETERMINATION.DEFINE',
  'Who a sale is made with, when it is not all one customer: the ship-to the delivery carries, the bill-to the invoice is addressed to, and the payer the receivable is posted against.',
  997,
  'STANDARD',
  '/foundation/partners',
  true,
  'MIGRATION_9242'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9242',
  changed_at = now();
