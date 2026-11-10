-- 9250: money before the goods.
--
-- §4.1 gave an order item a billing plan, and every date of that plan could do exactly one thing:
-- raise an invoice. Which is the right answer for the money the item has earned and no answer at all
-- for the money a customer is asked to pay in advance. A customer who pays thirty per cent before a
-- machine is built has paid it against an order that has delivered nothing, and an invoice that bills
-- the whole of the item when the goods finally go out asks for that thirty per cent a second time.
--
-- SAP's answer is the down payment, and it is three acts, not one. A **request** — a billing document
-- in Sales, posted to accounting as a *noted item*: a drawn number and no journal at all, because a
-- customer asked for money is not yet a customer who owes it. A **receipt** — the money arrives under
-- a special G/L indicator, on an alternative reconciliation account, outside the customer's ordinary
-- receivables. And a **clearing** at final billing, which transfers the advance onto the receivable so
-- that billed amount less down payment amount is what is still to pay.
--
-- The accounting engine has owned all three for a while (SCR-083 to SCR-085): the noted item, the
-- receipt against an indicator, the transfer posting that settles one against the other, with the
-- remainders derived from the posted lines so that nothing can be cleared twice. What was missing is
-- the whole of the sales side, and that is what stands here.
--
-- So four things. A date of a plan carries a **billing rule** — down payment or invoice — because SAP
-- draws that line at the date and not at the plan type: one plan asks for an advance on one date and
-- bills the whole on another. A request is raised from a down payment date as a billing document of
-- type DP, recorded here beside the accounting request it stands behind. An invoice of that order
-- carries what it cleared, so the document can say what has to be said: billed, less the advance, is
-- what is still owed. And the type itself is delivered.
--
-- Nothing here is a new capability. Asking for an advance from an order is a commercial act guarded by
-- the billing code, and undoing it is guarded by the cancellation code. The noted item posts nothing
-- at all, which is the whole reason it needs no posting authority of its own: the money cannot move
-- without the receipt, and the receipt is accounting's own act.

-- What a date asks for. INVOICE is what every date has always done, and it is the default, so every
-- plan standing today keeps exactly the meaning it has. DOWN_PAYMENT asks for the money early: it
-- raises a request, it posts no revenue, and the final invoice still bills the whole.
alter table sales_billing_plan_date
  add column if not exists billing_rule varchar(12) not null default 'INVOICE';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_billing_plan_date_rule_ck') then
    alter table sales_billing_plan_date
      add constraint sales_billing_plan_date_rule_ck
      check (billing_rule in ('DOWN_PAYMENT', 'INVOICE'));
  end if;
end $$;

comment on column sales_billing_plan_date.billing_rule is
  'What billing this date does: DOWN_PAYMENT asks the customer for an advance — a request, a noted '
  'item, no revenue — and INVOICE bills the share of the item that falls due. SAP draws the line at '
  'the date and not at the plan type, because one plan asks for an advance on one date and bills the '
  'whole on another.';

-- An advance asked for: the sales side of a down payment request, and the accounting request it
-- stands behind. The money itself is accounting's — the request is a noted item and the receipt is
-- posted under a special G/L indicator — and what is kept here is the link, so a reader of the order
-- can see what was asked, what arrived and what was cleared without leaving the sale.
create table if not exists sales_down_payment_request (
  client varchar(4) not null references client (client) on delete cascade,
  -- The billing document that asked for it: a document of type DP, raised against a plan date.
  billing_number varchar(20) not null,
  order_number varchar(20) not null,
  order_line_number integer not null,
  date_number integer not null,
  -- The accounting noted item this request stands behind. Statistical: no journal, no balance.
  request_number varchar(20) not null,
  customer_number varchar(40) not null,
  company_code varchar(10) not null,
  currency char(3) not null,
  -- What was asked, as money: the date's share of the item's gross value, because what the customer
  -- pays is net plus tax.
  amount numeric(23, 4) not null,
  -- OPEN while it stands, CLEARED once an invoice has consumed it, CANCELLED where it was withdrawn
  -- before any money arrived.
  status varchar(12) not null default 'OPEN',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, billing_number),
  foreign key (client, billing_number)
    references billing_document (client, billing_number) on delete cascade,
  constraint sales_down_payment_request_amount_ck check (amount > 0),
  constraint sales_down_payment_request_status_ck check (status in ('OPEN', 'CLEARED', 'CANCELLED'))
);

comment on table sales_down_payment_request is
  'An advance asked for on a sales order before anything was delivered (SAP F-37): the billing '
  'document that asked, the plan date it was raised from, and the accounting noted item behind it. '
  'Asking posts nothing — the noted item is statistical — and the money arrives only through the '
  'special G/L receipt, which is accounting''s own act.';

create index if not exists sales_down_payment_request_order_idx
    on sales_down_payment_request (client, order_number);

-- What an invoice consumed. A customer who paid part of the order in advance has already given that
-- money, and the document has to be able to say so: billed, less the advance, is what is still owed.
alter table billing_document
  add column if not exists down_payment_clearing_number varchar(20);
alter table billing_document
  add column if not exists down_payment_cleared_amount numeric(23, 4) not null default '0';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_document_cleared_amount_ck') then
    alter table billing_document
      add constraint billing_document_cleared_amount_ck
      check (down_payment_cleared_amount >= 0);
  end if;
end $$;

comment on column billing_document.down_payment_cleared_amount is
  'The advances of this order that this invoice consumed, in its own currency. Cleared by a transfer '
  'posting that moves the advance onto the receivable, so the amount still to pay is the billed value '
  'less this. Zero on a down payment request, which is an advance asked for and not a receivable.';

-- One invariant has to be restated, not broken. A posted billing document names the accounting
-- invoice behind it — because a document that bills posts a receivable — with one exception: a down
-- payment request is posted, in the sense that it stands and was sent, and names no invoice at all,
-- because asking for an advance posts nothing. The noted item is statistical: a drawn number and no
-- journal. The exception is the document type, and it is written where the invariant is written so
-- that the two cannot drift apart.
alter table billing_document drop constraint if exists billing_document_posted_needs_invoice_ck;
alter table billing_document
  add constraint billing_document_posted_needs_invoice_ck
  check (status <> 'POSTED'
      or document_type = 'DP'
      or (customer_invoice_number is not null and journal_document_number is not null));

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. What a customer was asked to pay in advance is part of the sale.
alter table sales_down_payment_request enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_down_payment_request']
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

-- The document type, for every tenant that stands. A tenant created from now on gets the same row
-- from the standard configuration package, which is the only half that reaches it. It draws from the
-- billing interval every tenant that can invoice already carries: a second interval is configuration
-- a tenant may make, not a prerequisite for asking for an advance. It names no cancellation type,
-- because a request is not undone by a second document — it is withdrawn, and only while no money
-- has arrived against it.
insert into sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object,
  cancellation_document_type, is_active, pricing_procedure, created_by
)
select c.client, 'DP', 'Down payment request', 'BILLING', 'F2', null, true, 'A', 'MIGRATION_9250'
  from public.client c
on conflict (client, document_type) do nothing;
