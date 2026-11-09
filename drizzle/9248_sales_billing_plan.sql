-- 9248: what is billed when.
--
-- Billing in this package has had exactly one source: a delivery whose goods have gone out. The
-- delivery states what went, the invoice bills it, and the two are tied together by an index that
-- lets one live document stand per delivery. That is right for goods, and it silently makes every
-- other kind of sale unbillable. Twelve months of maintenance, a piece of work paid in three stages,
-- a licence renewed every quarter: none of them is delivered, so none of them can be invoiced.
--
-- SAP's answer is the billing plan (FPLA/FPLT): a set of dates hanging off the order item, each
-- carrying a share of the item's value, each billing when its day arrives. Not a reminder, and not a
-- report — the plan *is* the billing schedule, and an item that carries one is billed by it rather
-- than by whatever happens to be delivered.
--
-- So this migration does three things.
--
-- First, the plan: a plan per order item, its dates, and a delivered catalogue of the two kinds a plan
-- comes in — periodic, whose dates are proposed from a start date and a frequency, and milestone,
-- whose dates are entered one by one. The catalogue is delivered with the package and not extended,
-- for the same reason the partner functions are not: what a plan type means is what the code does
-- with it, and a third would be a row that answered nothing.
--
-- Second, the billing document itself is freed from the delivery. Its delivery columns become
-- nullable and the index that held one live document per delivery becomes partial, so the index and
-- the service keep saying the same thing: a delivery-related document is one per delivery, and an
-- order-related document, which names no delivery at all, is not counted against that.
--
-- Third, the capability that guards the screen. The sales clerk holds SALES.*, and the pattern
-- reaches every code below it, so no grant is written — a pattern is granted once and the codes
-- under it arrive by themselves.
--
-- Nothing here touches a down payment. That is the next increment: a request, a noted item against a
-- special G/L indicator, and a clearing at final billing. A plan date today raises an invoice, and
-- only an invoice.

create table if not exists sales_billing_plan_type (
  client varchar(4) not null references client (client) on delete cascade,
  plan_type varchar(2) not null,
  display_name varchar(80) not null,
  -- What the type is for, in words, so no screen and no report has to guess at PE and MS.
  meaning varchar(240) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, plan_type),
  constraint sales_billing_plan_type_code_ck check (plan_type in ('PE', 'MS'))
);

comment on table sales_billing_plan_type is
  'The two kinds of billing plan an order item can carry (SAP FPLA-FPTYP): periodic, whose dates are '
  'proposed from a start date and a frequency, and milestone, whose dates are entered one by one '
  'and each stand for a piece of work. Delivered with the package and not extended, because what a '
  'plan type means is what the code does with it.';

create table if not exists sales_billing_plan (
  client varchar(4) not null references client (client) on delete cascade,
  order_number varchar(20) not null,
  order_line_number integer not null,
  plan_type varchar(2) not null,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, order_number, order_line_number),
  foreign key (client, order_number, order_line_number)
    references sales_order_line (client, order_number, line_number) on delete cascade,
  foreign key (client, plan_type)
    references sales_billing_plan_type (client, plan_type) on delete restrict,
  constraint sales_billing_plan_version_ck check (version > 0)
);

comment on table sales_billing_plan is
  'When an order item is billed (SAP FPLA). One plan per item: an item is billed by the dates its '
  'plan carries, and by its deliveries when it carries no plan — never by both, because a share of '
  'an item and the whole of it are two different answers to one question.';

create table if not exists sales_billing_plan_date (
  client varchar(4) not null references client (client) on delete cascade,
  order_number varchar(20) not null,
  order_line_number integer not null,
  date_number integer not null,
  billing_date date not null,
  percentage numeric(6, 3) not null,
  status varchar(16) not null default 'OPEN',
  -- The document that billed this date. Null while the date stands open, and cleared again when that
  -- document is cancelled: a cancelled invoice releases the date, as it releases the delivery it
  -- stands against, so the corrected document can be raised.
  billing_number varchar(20),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, order_number, order_line_number, date_number),
  foreign key (client, order_number, order_line_number)
    references sales_billing_plan (client, order_number, order_line_number) on delete cascade,
  constraint sales_billing_plan_date_status_ck check (status in ('OPEN', 'BILLED')),
  constraint sales_billing_plan_date_number_ck check (date_number > 0),
  constraint sales_billing_plan_date_percentage_ck check (percentage > 0 and percentage <= 100),
  constraint sales_billing_plan_date_billed_ck
    check ((status = 'BILLED' and billing_number is not null)
        or (status = 'OPEN' and billing_number is null))
);

comment on table sales_billing_plan_date is
  'One date of a billing plan (SAP FPLT): the day it falls on and the share of the item''s value it '
  'bills. The percentages of one plan total one hundred — a plan that promises ninety has not said '
  'when the last tenth is billed. A date is billed once, and only on or after the day it names.';

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. When an item is billed is part of what the sale was.
alter table sales_billing_plan_type enable row level security;
alter table sales_billing_plan enable row level security;
alter table sales_billing_plan_date enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_billing_plan_type', 'sales_billing_plan', 'sales_billing_plan_date']
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

-- The two plan types, for every tenant that stands. A tenant created from now on gets the same two
-- rows from the standard configuration package, which is the only half that reaches it.
insert into sales_billing_plan_type (client, plan_type, display_name, meaning, created_by)
select c.client, seed.plan_type, seed.display_name, seed.meaning, 'MIGRATION_9248'
  from public.client c
  cross join (
    values
      ('PE', 'Periodic',
       'Billing on a repeating schedule: dates proposed from a start date and a frequency in months, each carrying an equal share or a share the maintainer names.'),
      ('MS', 'Milestone',
       'Billing when a piece of work is reached: dates entered one by one, each carrying the share that falls due when that stage is met.')
  ) as seed (plan_type, display_name, meaning)
on conflict (client, plan_type) do nothing;

-- A billing document no longer has to name a delivery. An order-related document — one raised against
-- a billing plan date — names the order and the item, and the delivery columns stay empty: nothing
-- was shipped, and a column that said otherwise would be a fact invented for the convenience of a
-- not-null constraint.
alter table billing_document alter column delivery_number drop not null;
alter table billing_document_line alter column delivery_number drop not null;
alter table billing_document_line alter column delivery_line_number drop not null;

comment on column billing_document.delivery_number is
  'The delivery this document bills. Null on an order-related document, which is raised against a '
  'billing plan date and bills a share of an item rather than goods that went out. The index beside '
  'this column holds one live document per delivery, and only counts the documents that name one.';

-- One live document per delivery — and only where a delivery is named. This is the same predicate the
-- service applies, because a service that disagreed with the index would refuse a document the
-- database would have accepted, or the other way round.
drop index if exists billing_document_delivery_live_uq;
create unique index billing_document_delivery_live_uq
    on billing_document (client, delivery_number)
 where delivery_number is not null
   and status <> 'CANCELLED'
   and credit_of is null
   and cancellation_of is null;

-- The screen that maintains a plan, and the code that guards it. Maintaining a plan is a commercial
-- act: it names no price and posts nothing, and the money still arrives only when a date is billed,
-- which is SALES.BILLING.CREATE.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.BILLING_PLAN.MAINTAIN', 'SALES', 'MAINTAIN', false,
  'Maintain a billing plan on a sales order item at /sales/billing-plans: the dates an item is billed on and the share of its value each one carries. Percentages total one hundred, a date is billed once and only on or after the day it names, and an item that carries a plan is billed by the plan and not by its deliveries. It posts no accounting document; the invoice is raised when a date is billed, which is SALES.BILLING.CREATE.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
