-- The credit memo: the document that gives the customer their money back.
--
-- The chain so far can take goods back and it can put them back in stock, but the customer is still
-- invoiced for them. What closes the loop is the credit memo, SAP's G2: a billing document raised
-- against the invoice, carrying the value back the other way.
--
-- Three facts are added here.
--
-- The first two are the type and its interval, seeded for every tenant that already stands — the
-- catalogue in code covers tenants created from now on, and this covers the ones that do not.
--
-- The third is the shape of the document. A credit memo names the invoice it credits, on the header,
-- because a credit with nothing behind it is a discount nobody authorised; and its lines name the
-- invoiced line they were priced from, which is what makes "priced from the original billing line" a
-- fact rather than an intention — the price, the tax and the material are the ones that line carried.
-- A credit is either a G2 naming its invoice, or it is not a credit at all and names nothing. And a
-- credit memo carries credit: its value is what the customer is being given back, so a positive
-- figure on a G2 is a charge wearing the wrong coat.

insert into public.sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, created_by
)
select c.client, 'G2', 'Credit memo', 'BILLING', 'G2', 'MIGRATION'
  from public.client c
on conflict (client, document_type) do nothing;

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'BILLING', '*', 'G2', 0, 'CM', 1, 999999, 0, 7, 'READABLE', false, 'MIGRATION'
  from public.client c
on conflict do nothing;

alter table public.billing_document_line
  add column reference_billing_number varchar(20);
alter table public.billing_document_line
  add column reference_billing_line_number integer;

alter table public.billing_document_line
  drop constraint if exists billing_document_line_billing_reference_ck;
alter table public.billing_document_line
  add constraint billing_document_line_billing_reference_ck
  check ((reference_billing_number is null) = (reference_billing_line_number is null));

alter table public.billing_document_line
  drop constraint if exists billing_document_line_billing_reference_fk;
alter table public.billing_document_line
  add constraint billing_document_line_billing_reference_fk
  foreign key (client, reference_billing_number)
  references public.billing_document (client, billing_number);

alter table public.billing_document
  drop constraint if exists billing_document_credit_reference_ck;
alter table public.billing_document
  add constraint billing_document_credit_reference_ck
  check ((document_type = 'G2') = (credit_of is not null));

-- A document that stands on its own carries a value that is not negative. A cancellation carries the
-- value it reverses, and a credit memo carries the value it gives back, sign and all. The constraint was
-- narrowed for the cancellation when that document arrived; it is narrowed again here for the credit,
-- rather than in the service, so that no future writer — a correction screen, an import, a second credit
-- path — can file a credit whose value quietly adds to what the customer owes instead of clearing it.
alter table public.billing_document
  drop constraint if exists billing_document_value_ck;
alter table public.billing_document
  add constraint billing_document_value_ck check (
    (cancellation_of is null and credit_of is null
     and net_value >= 0 and tax_value >= 0 and gross_value >= 0)
    or
    (cancellation_of is not null
     and net_value <= 0 and tax_value <= 0 and gross_value <= 0)
    or
    (credit_of is not null
     and net_value <= 0 and tax_value <= 0 and gross_value <= 0)
  );

-- One level down, the same idea without the header to ask: a line carries the price, the net and the tax
-- of one direction, never a mixture of the two. A credit memo's lines are the invoice's own figures with
-- the sign turned round — the goods are the same goods, going back.
alter table public.billing_document_line
  drop constraint if exists billing_document_line_amount_ck;
alter table public.billing_document_line
  add constraint billing_document_line_amount_ck check (
    (net_price >= 0 and net_amount >= 0 and tax_amount >= 0)
    or
    (net_price <= 0 and net_amount <= 0 and tax_amount <= 0)
  );

comment on column public.billing_document_line.reference_billing_number is
  'The invoiced line this line was priced from, on a credit memo. The price, the tax and the material are the ones that line carried, so the credit settles what was actually invoiced.';
comment on column public.billing_document_line.reference_billing_line_number is
  'The line of the billing document named in reference_billing_number. Null if and only if that column is null.';
