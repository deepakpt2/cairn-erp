-- 9238: pricing becomes a procedure, and the document keeps the conditions that priced it.
--
-- An order price was `PR00` in a constant and the tax was a rate the service read from the tax master
-- and applied by hand. Two pricing facts, neither of them describable: a customer discount, a freight
-- charge and an output tax are not three new pieces of code, they are the same thing seen three ways —
-- a figure, a base it is calculated on, a sign, and a key the ledger is determined by. So the four
-- become rows in a condition type master, and their order and their bases become steps of a procedure
-- that a tenant determines per sales area, document type and customer.
--
-- What is deliberately not configurable is how a figure becomes an amount. `FIXED` and `PERCENTAGE`
-- are the two calculations the engine executes; scales, requirement routines and user-defined condition
-- tables are not carried, because a pricing engine that can be programmed is a programming language,
-- and this one has to be auditable.
--
-- The condition type is a row now, so the check constraint that said `condition_type = 'PR00'`
-- becomes a foreign key to that master: what may be maintained is configuration, and a constraint
-- cannot read a table.
--
-- And the document keeps its conditions. SAP's KONV exists because a document line carries totals
-- only, and a discounted invoice whose arithmetic lives nowhere is a number nobody can defend. Every
-- step that contributed a figure is written on the document: the type, the record that answered, the
-- base, the rate, the amount. That is also what lets a later increment re-price a historic document
-- and prove it did not move.
--
-- Grants are SELECT, INSERT and UPDATE on the five new tables, and no DELETE: a condition type with
-- records standing under it is withdrawn rather than removed, and a document condition is history.

create table if not exists sales_condition_type (
  client varchar(4) not null references client (client) on delete cascade,
  condition_type varchar(4) not null,
  name varchar(40) not null,
  condition_class varchar(10) not null,
  calculation_type varchar(16) not null,
  is_negative boolean not null default false,
  is_statistical boolean not null default false,
  account_key varchar(3),
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, condition_type),
  check (condition_class in ('PRICE', 'DISCOUNT', 'FREIGHT', 'TAX', 'COST')),
  check (calculation_type in ('FIXED', 'PERCENTAGE', 'MATERIAL_COST'))
);

create table if not exists sales_pricing_procedure (
  client varchar(4) not null references client (client) on delete cascade,
  procedure_code varchar(6) not null,
  name varchar(40) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, procedure_code)
);

create table if not exists sales_pricing_procedure_step (
  client varchar(4) not null references client (client) on delete cascade,
  procedure_code varchar(6) not null,
  step_number integer not null,
  condition_type varchar(4) not null,
  from_step integer,
  to_step integer,
  is_required boolean not null default false,
  -- ITEM stands once for every item; HEADER stands once for the document and is distributed to the
  -- items in proportion to what each is worth, so a later step can be calculated on it and the ledger
  -- can be determined per line.
  condition_level varchar(6) not null default 'ITEM',
  -- A withdrawn step is not executed. There is no delete: a step is part of the rule a document was
  -- priced by, and a document read years from now must still be able to say what priced it.
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, procedure_code, step_number),
  foreign key (client, procedure_code) references sales_pricing_procedure (client, procedure_code) on delete restrict,
  foreign key (client, condition_type) references sales_condition_type (client, condition_type) on delete restrict,
  check ((from_step is null) = (to_step is null)),
  check (from_step is null or to_step is null or from_step <= to_step),
  check (condition_level in ('ITEM', 'HEADER'))
);

create table if not exists sales_procedure_determination (
  client varchar(4) not null references client (client) on delete cascade,
  -- Blank means "any": a tenant is served by one row today, and a row for one sales area can be
  -- maintained beside it tomorrow without backfilling anything.
  sales_org varchar(4) not null default '',
  distribution_channel varchar(2) not null default '',
  division varchar(2) not null default '',
  document_pricing_procedure varchar(6) not null,
  -- '*' means any customer pricing procedure, which is what the delivered row says: the standard
  -- procedure prices every customer until a tenant maintains otherwise.
  customer_pricing_procedure varchar(6) not null,
  procedure_code varchar(6) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, sales_org, distribution_channel, division,
               document_pricing_procedure, customer_pricing_procedure),
  foreign key (client, procedure_code) references sales_pricing_procedure (client, procedure_code) on delete restrict
);

create table if not exists sales_document_condition (
  client varchar(4) not null references client (client) on delete cascade,
  document_category varchar(10) not null,
  document_number varchar(20) not null,
  line_number integer not null,
  -- ITEM was priced on that line; HEADER is the whole of a header condition, standing at line 0;
  -- DISTRIBUTED is the share of a header condition that fell to this line.
  origin varchar(11) not null default 'ITEM',
  step_number integer not null,
  condition_type varchar(4) not null,
  base_value numeric(23,4) not null default 0,
  rate numeric(13,6) not null default 0,
  amount numeric(23,4) not null default 0,
  price_unit integer not null default 1,
  currency char(3) not null,
  condition_number varchar(18),
  account_key varchar(3),
  is_statistical boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_category, document_number, line_number, step_number),
  foreign key (client, condition_type) references sales_condition_type (client, condition_type) on delete restrict,
  check (document_category in ('ORDER', 'BILLING')),
  check (origin in ('ITEM', 'HEADER', 'DISTRIBUTED')),
  check ((origin = 'HEADER' and line_number = 0) or (origin <> 'HEADER' and line_number > 0))
);

alter table sales_document_type
  add column if not exists pricing_procedure varchar(6) not null default 'A';

-- The type a condition record carries is a row in the master now. Every record standing says PR00,
-- which the delivered master carries, so the foreign key is satisfied by what is already there.
alter table sales_condition_record
  drop constraint if exists sales_condition_record_type_ck;
alter table sales_condition_record
  add constraint sales_condition_record_type_fk
  foreign key (client, condition_type) references sales_condition_type (client, condition_type) on delete restrict;

comment on table sales_condition_type is
  'What a pricing condition is: its class, how its figure becomes an amount, whether it adds or takes away, and the key the G/L account is determined by. Delivered with PR00, K007, KF00, HD00, VPRS and MWST; maintained with the procedure that uses it.';
comment on table sales_pricing_procedure_step is
  'One step of a pricing procedure: a condition type, the span of steps its percentage is calculated on, and whether the document may go without it. The span is what makes a tax different from a discount.';
comment on table sales_procedure_determination is
  'Which pricing procedure answers, by sales area, document pricing procedure and customer pricing procedure — SAP OVKK. A document is priced by a rule that stands, or it is not priced.';
comment on table sales_document_condition is
  'The conditions a document was priced by, step by step: the type, the record that answered, the base, the rate and the amount. The document line carries the totals; this is the arithmetic behind them, kept so a document can be re-read years later and proved not to have moved.';
comment on column sales_document_type.pricing_procedure is
  'The document pricing procedure key this type carries into the procedure determination, as VOV8 carries it. It names a key, not a procedure: who prices this document depends on the sales area and the customer too.';

-- The delivered master. Six condition types, and the calculation each one executes: the price and the
-- freight are figures per price unit, the discount and the tax are percentages of a span of steps, and
-- the cost is read from the valuation of the material at the plant.
insert into sales_condition_type (
  client, condition_type, name, condition_class, calculation_type,
  is_negative, is_statistical, account_key, created_by
)
select c.client, v.condition_type, v.name, v.condition_class, v.calculation_type,
       v.is_negative, v.is_statistical, v.account_key, 'MIGRATION_9238'
  from client c
  cross join (values
    ('PR00', 'Price', 'PRICE', 'FIXED', false, false, 'ERL'),
    ('K007', 'Customer discount', 'DISCOUNT', 'PERCENTAGE', true, false, 'ERS'),
    ('KF00', 'Freight', 'FREIGHT', 'FIXED', false, false, 'ERF'),
    ('HD00', 'Header freight', 'FREIGHT', 'FIXED', false, false, 'ERF'),
    ('VPRS', 'Cost', 'COST', 'MATERIAL_COST', false, true, null::varchar),
    ('MWST', 'Output tax', 'TAX', 'PERCENTAGE', false, false, 'MWS')
  ) as v(condition_type, name, condition_class, calculation_type, is_negative, is_statistical, account_key)
on conflict (client, condition_type) do nothing;

-- The delivered procedure: price, discount on the price, freight, header freight, tax on what
-- survived all three, and the cost the document shows and never charges. The spans are the whole
-- point — a tax charged on the gross would be a tax on a discount the customer never paid.
insert into sales_pricing_procedure (client, procedure_code, name, created_by)
select client, 'RVAA01', 'Standard sales pricing', 'MIGRATION_9238' from client
on conflict (client, procedure_code) do nothing;

insert into sales_pricing_procedure_step (
  client, procedure_code, step_number, condition_type, from_step, to_step, is_required,
  condition_level, created_by
)
select c.client, 'RVAA01', v.step_number, v.condition_type, v.from_step, v.to_step, v.is_required,
       v.condition_level, 'MIGRATION_9238'
  from client c
  cross join (values
    (10, 'PR00', null::integer, null::integer, true, 'ITEM'),
    (20, 'K007', 10, 10, false, 'ITEM'),
    (30, 'KF00', null::integer, null::integer, false, 'ITEM'),
    -- The header freight stands before the tax and inside its base: a tax that ignored the freight
    -- would tax the goods and not the charge for carrying them.
    (35, 'HD00', null::integer, null::integer, false, 'HEADER'),
    (40, 'MWST', 10, 35, false, 'ITEM'),
    -- The cost is statistical: it is shown, and it is in no total and no ledger line. It is read from
    -- the valuation of the material, not from a record, because a cost is what the books say it is.
    (50, 'VPRS', null::integer, null::integer, false, 'ITEM')
  ) as v(step_number, condition_type, from_step, to_step, is_required, condition_level)
on conflict (client, procedure_code, step_number) do nothing;

-- The delivered determination: one row per tenant, worth any sales area and any customer procedure.
-- A tenant whose customers carry no pricing procedure of their own still prices, which is the whole
-- reason the wildcard is a row and not a fallback in the engine — it can be read, and it can be
-- replaced by a row that names a customer procedure.
insert into sales_procedure_determination (
  client, sales_org, distribution_channel, division,
  document_pricing_procedure, customer_pricing_procedure, procedure_code, created_by
)
select p.client, '', '', '', 'A', '*', 'RVAA01', 'MIGRATION_9238'
  from sales_pricing_procedure p
 where p.procedure_code = 'RVAA01'
on conflict (client, sales_org, distribution_channel, division,
             document_pricing_procedure, customer_pricing_procedure) do nothing;

-- Row-level security: a tenant reads its own pricing and nothing else's, which is the only rule a
-- price has ever needed.
alter table sales_condition_type enable row level security;
alter table sales_condition_type force row level security;
alter table sales_pricing_procedure enable row level security;
alter table sales_pricing_procedure force row level security;
alter table sales_pricing_procedure_step enable row level security;
alter table sales_pricing_procedure_step force row level security;
alter table sales_procedure_determination enable row level security;
alter table sales_procedure_determination force row level security;
alter table sales_document_condition enable row level security;
alter table sales_document_condition force row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'sales_condition_type', 'sales_pricing_procedure', 'sales_pricing_procedure_step',
    'sales_procedure_determination', 'sales_document_condition'
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

-- The capability and the workbench activity. They stand because the screen stands: every refusal the
-- pricing engine raises names /config/pricing-procedure, and a remedy that points at a route nothing
-- serves is the fault the document type carried before 9236 gave it an address.

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.PRICING.DEFINE', 'SALES', 'CONFIGURE', false,
  'Define the pricing procedure at /config/pricing-procedure: the condition types a figure can carry, the ordered steps of the procedure that calculates them, and the determination that decides which procedure answers for a sales area, a document type and a customer. Nothing is deleted: a step is withdrawn, because the documents already priced keep the rule they were priced under. It creates no document and posts nothing.'
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
  'CFG.SALES.PRICING.DEFINE',
  'SALES_AND_DISTRIBUTION',
  null,
  'Define pricing procedures',
  'DEFINE',
  'CFG.SALES.DOCTYPE.DEFINE',
  'How every sales document is priced: which condition types a figure can carry, the order they are calculated in, and which procedure answers for a sales area, a document type and a customer. Where no determination stands, no document is priced.',
  992,
  'STANDARD',
  '/config/pricing-procedure',
  true,
  'MIGRATION_9238'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9238',
  changed_at = now();
