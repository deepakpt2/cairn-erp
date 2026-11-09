-- 9251: money given back.
--
-- Every increment before this one has been about taking the money: an order at a price, an invoice for
-- what was delivered, an advance before the goods went out, a credit where the complaint was good.
-- What none of them can say is the thing a purchasing director asks for first — *sell us a hundred
-- thousand this year and two per cent comes back* — and what none of them can answer is what such a
-- promise has cost the company so far.
--
-- SAP's rebate is three acts with a gap between them. The **agreement** says who the promise was made
-- to, over what period and on what terms; it is maintained and then **released**, because a provision
-- nobody authorised is worse than no provision. The **accrual** happens when the invoice is posted:
-- the sale earned part of the promise, and accounting hears about it now, not when the cheque is
-- written. At billing the rebate is calculated on the line's net value — the rebate basis — and
-- posted as a provision: the sales deduction the ERS key names is debited, and the accrual the ERU
-- key names is credited. The customer still pays the whole invoice; the rebate is a promise recorded
-- beside it, which is what a statistical condition is for. Then the **settlement**, later: a credit
-- memo for what accrued, which reverses the provision and credits the customer.
--
-- That is what stands here. An agreement, its rates as condition records, the accrual a billing
-- document earns, and the settlement that pays it out. And one thing that follows from the first two:
-- a cancelled billing document takes its accrual with it, because a provision built on a sale that was
-- undone is an overstatement that never corrects itself.
--
-- Why the accrual is not a step in the pricing procedure, which is where every other figure in a
-- document comes from: a rebate is earned over a period, not by a document, and a step would price
-- every order with it. SAP reaches the same answer with requirement routine 24, which calls the
-- rebate condition up in billing documents and nowhere else. The rate is a condition record, priced
-- where every other rate is priced; when it is called up is this module's business.
--
-- So: two tables, a condition class, the delivered condition type and the account its key determines,
-- and one capability. Maintaining an agreement is a commercial act that posts nothing, which is why it
-- is guarded in its own right; the accrual rides on SALES.BILLING.CREATE, which is the act that
-- earned it, and the settlement gives the company's money away, which is SALES.CREDIT.MEMO.POST.

-- The agreement: a promise to give a payer part of what they spend back (SAP VBO1). It carries no
-- total. What has accrued, what was reversed and what was settled are read from the accrual rows, as
-- a receivable is read from its open items: a stored total is a second copy of a number that only ever
-- has to be right once.
create table if not exists sales_rebate_agreement (
  client varchar(4) not null references client (client) on delete cascade,
  agreement_number varchar(20) not null,
  -- The payer. The promise is made with the partner who pays, not with the partner the goods go to,
  -- and it is the payer's account the settlement credits.
  customer_number varchar(40) not null,
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  division varchar(2) not null,
  currency char(3) not null references currency (code),
  valid_from date not null,
  valid_to date not null,
  -- Which rebate condition type the agreement's rates are maintained under. A tenant may maintain
  -- several — a volume rebate and a listing fee are different promises — and the agreement says which
  -- records answer for it.
  condition_type varchar(4) not null default 'BO01',
  -- OPEN while it is being maintained, RELEASED once somebody with authority over the company's money
  -- agreed to it, SETTLED when the final settlement was paid out, CLOSED where it was abandoned.
  status varchar(12) not null default 'OPEN',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, agreement_number),
  foreign key (client, condition_type)
    references sales_condition_type (client, condition_type) on delete restrict,
  constraint sales_rebate_agreement_status_ck
    check (status in ('OPEN', 'RELEASED', 'SETTLED', 'CLOSED')),
  constraint sales_rebate_agreement_validity_ck check (valid_to >= valid_from)
);

comment on table sales_rebate_agreement is
  'A promise to give a payer part of what they spend back over a period (SAP VBO1): who it is with, '
  'the sales area it covers, the dates it runs between and the rebate condition type its rates are '
  'maintained under. An agreement accrues only once it stands released, which is the act that says '
  'somebody authorised the provision.';

create index if not exists sales_rebate_agreement_customer_idx
    on sales_rebate_agreement (client, customer_number, sales_org);

-- One accrual: the rebate one line of one billing document earned against one agreement. Several
-- agreements can accrue on the same sale, which is why the agreement belongs to the key.
create table if not exists sales_rebate_accrual (
  client varchar(4) not null references client (client) on delete cascade,
  agreement_number varchar(20) not null,
  billing_number varchar(20) not null,
  line_number integer not null,
  order_number varchar(20) not null,
  order_line_number integer not null,
  material_number varchar(40) not null,
  currency char(3) not null,
  -- What the rebate was calculated on: the net value of the line. SAP's rebate basis, and the figure
  -- the provision is measured against.
  basis_amount numeric(23, 4) not null,
  -- What was provided for.
  rebate_amount numeric(23, 4) not null,
  -- The record that priced it, so a reader can name the rate without reading the agreement.
  condition_number varchar(18) not null,
  -- The journal that carried the provision to the ledger.
  journal_document_number varchar(20),
  -- The journal that took it back when the billing document was cancelled.
  reversal_journal_document_number varchar(20),
  -- How much of the provision has been paid out, and by which credit memo. A settlement may pay part
  -- of what stands and leave the rest accruing, so the two figures are kept apart: what was provided
  -- for is the provision, what was paid out of it is history, and the difference is what the company
  -- still owes the customer.
  settled_amount numeric(23, 4) not null default 0,
  settlement_number varchar(20),
  -- ACCRUED once posted, REVERSED where the billing document was cancelled, SETTLED once paid out.
  status varchar(12) not null default 'ACCRUED',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, agreement_number, billing_number, line_number),
  foreign key (client, agreement_number)
    references sales_rebate_agreement (client, agreement_number) on delete cascade,
  foreign key (client, condition_number)
    references sales_condition_record (client, condition_number) on delete restrict,
  constraint sales_rebate_accrual_status_ck
    check (status in ('ACCRUED', 'REVERSED', 'SETTLED')),
  constraint sales_rebate_accrual_amount_ck check (rebate_amount >= 0),
  -- What was paid out of a provision can never be more than the provision, and never less than
  -- nothing: a settlement that gave the customer more than the company provided for is not a partial
  -- settlement of a rebate, it is money given away against nothing at all.
  constraint sales_rebate_accrual_settled_ck
    check (settled_amount >= 0 and settled_amount <= rebate_amount)
);

comment on table sales_rebate_accrual is
  'One rebate earned by one line of one billing document against one agreement: the net value it was '
  'calculated on, the amount provided for, the record that priced it, and where it stands — accrued, '
  'reversed because the document was cancelled, or settled by the credit memo that paid it out. The '
  'rebate is a provision: the customer pays the whole invoice, and the money goes back on a document '
  'of its own.';

create index if not exists sales_rebate_accrual_billing_idx
    on sales_rebate_accrual (client, billing_number);
create index if not exists sales_rebate_accrual_agreement_idx
    on sales_rebate_accrual (client, agreement_number, status);

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. What a customer was promised, and what it has cost so far, is part of the
-- sale.
alter table sales_rebate_agreement enable row level security;
alter table sales_rebate_accrual enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_rebate_agreement', 'sales_rebate_accrual']
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

-- A class of its own, because a rebate is none of the five that stand. It is not a price: it does not
-- say what the customer pays. It is not a discount: the customer pays the whole of it and gets part of
-- it back later. It is revenue the company has earned and promised to hand back, which is a thing the
-- chart has an account for and the pricing classes do not.
-- The constraint the table was created with carries the name the database gave it, and not the one the
-- schema declares, so the old name is the one that has to go. The new one is named as the schema names
-- it, so that a reader comparing the two is not left wondering which is which.
alter table sales_condition_type drop constraint if exists sales_condition_type_condition_class_check;
alter table sales_condition_type drop constraint if exists sales_condition_type_class_ck;
alter table sales_condition_type
  add constraint sales_condition_type_class_ck
  check (condition_class in ('PRICE', 'DISCOUNT', 'FREIGHT', 'TAX', 'COST', 'REBATE'));

comment on column sales_condition_type.condition_class is
  'What the figure means: price, discount, freight, tax, cost — or rebate, which is none of the '
  'others. A rebate does not change what the customer pays on the document; it is earned over a '
  'period, accrued as a provision when the billing document is posted, and paid out on a settlement '
  'credit memo.';

-- The delivered rebate condition type, for every tenant that stands. A tenant created from now on gets
-- the same row from the standard configuration package, which is the only half that reaches it.
-- BO01 is the name SAP gives a rebate accrual. It is statistical because it changes nothing the
-- customer is charged, and it carries the ERU key because that is the key whose account holds the
-- accrual — the provision the settlement later releases.
insert into sales_condition_type (
  client, condition_type, name, condition_class, calculation_type,
  is_negative, is_statistical, account_key, created_by
)
select c.client, 'BO01', 'Rebate accrual', 'REBATE', 'PERCENTAGE',
       false, true, 'ERU', 'MIGRATION_9251'
  from public.client c
on conflict (client, condition_type) do nothing;

-- And the account ERU determines. The delivered determination covers the four keys the standard
-- procedure can produce; ERU was deliberately left out of it on the ground that no delivered
-- condition type produced that key. BO01 produces it, so the row that was waiting for something to
-- ask for it is delivered with it, against every chart that carries the accrued-liabilities account.
-- A tenant whose provision belongs elsewhere maintains the row: the package names the account it
-- delivers, and a determination is the one place a tenant is expected to disagree with it.
insert into sales_account_determination (
  client, chart_of_accounts, sales_org, customer_account_assignment_group,
  material_account_assignment_group, account_key, gl_account, is_active, created_by
)
select coa.client, coa.chart_of_accounts, '', '', '', 'ERU', '230000', true, 'MIGRATION_9251'
  from chart_of_accounts coa
 where exists (
   select 1 from gl_account g
    where g.client = coa.client
      and g.chart_of_accounts = coa.chart_of_accounts
      and g.account_number = '230000'
 )
on conflict (
  client, chart_of_accounts, sales_org,
  customer_account_assignment_group, material_account_assignment_group, account_key
) do nothing;

-- A number of its own. An agreement is a document the company is bound by, and a number it made up is
-- not a number that can be accounted for: two agreements cannot share one, and an agreement cannot be
-- renumbered because somebody typed it twice. So the object stands in the roster every tenant carries,
-- and an interval is delivered for the tenants that stood before it as well as for those provisioned
-- from now on, which get the same row from the provisioning path.
insert into number_range_object (client, object_code, description, number_length, year_relevant, subobject_hint, created_by)
select c.client, 'REBATE_AGR', 'Rebate agreements', 10, false, null, 'MIGRATION_9251'
  from public.client c
on conflict (client, object_code) do nothing;

insert into number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'REBATE_AGR', '*', '*', 0, 'RA', 1, 999999, 0, 10, 'READABLE', false, 'MIGRATION_9251'
  from public.client c
on conflict (client, object_code, company_code, sub_object, fiscal_year) do nothing;

-- The document the settlement is paid on, for every tenant that stands. It is a type of its own and not a
-- credit memo, because a credit memo credits an invoice and a settlement credits none: the invoices the
-- rebate was earned by stand in full, and what is being paid out is a promise made beside them. SAP calls
-- the same document B1. It draws from the billing interval under a sub-object of its own, and it names no
-- cancellation counterpart — a settlement is undone by cancelling the credit memo, not by a second
-- document raised against it.
insert into sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object,
  cancellation_document_type, is_active, pricing_procedure, created_by
)
select c.client, 'B1', 'Rebate settlement', 'BILLING', 'B1', null, true, 'A', 'MIGRATION_9251'
  from public.client c
on conflict (client, document_type) do nothing;

insert into number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'BILLING', '*', 'B1', 0, 'RS', 1, 999999, 0, 10, 'READABLE', false, 'MIGRATION_9251'
  from public.client c
on conflict (client, object_code, company_code, sub_object, fiscal_year) do nothing;

-- The capability. Maintaining an agreement posts nothing — the provision is created by the billing
-- document, and the money goes back through the settlement, which is SALES.CREDIT.MEMO.POST. What
-- this guards is the promise itself: deciding what the company has given away before a single invoice
-- has earned it.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.REBATE.MAINTAIN', 'SALES', 'MAINTAIN', false,
  'Maintain a rebate agreement at /sales/rebate-agreements: who a promise to pay part of what they spend back was made to, for which sales area, between which dates and priced by which rebate condition type. An agreement accrues only once it stands released, and only on billing documents posted inside its dates for the payer it names. Maintaining one posts nothing; the accrual follows the invoice, and the settlement that pays it out is SALES.CREDIT.MEMO.POST.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
