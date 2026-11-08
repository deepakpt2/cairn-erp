-- The returns order: the complaint a return is raised on.
--
-- A return today begins with a delivery: somebody decides goods are coming back, and the returns
-- delivery records it. What is missing is the document that says the customer asked for it, and
-- what they asked for — which in SAP is the returns order, RE, created with reference to the
-- invoice being returned against and copying its price and quantity. Without it the credit memo has
-- nothing to be priced from and nothing to name, and the quantity that may still come back is a
-- figure nobody can answer except by reading a delivery line.
--
-- Three facts are added here.
--
-- The first two are the type and its interval, seeded for every tenant that already stands — the
-- catalogue in code covers tenants created from now on, and this covers the ones that do not.
--
-- The third is the shape of the document. A returns order names the invoice it was raised against,
-- and the line names the billing line it was priced from, which is what lets a credit memo be
-- priced from the original billing line rather than from a condition record that may since have
-- been renegotiated. An order is either a return, naming what it was raised against, or it is not
-- one and names nothing: a reference that only sometimes means something is not a reference.

insert into public.sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, created_by
)
select c.client, 'RE', 'Returns', 'SALESORD', 'RE', 'MIGRATION'
  from public.client c
on conflict (client, document_type) do nothing;

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'SALESORD', '*', 'RE', 0, 'RO', 1, 999999, 0, 7, 'READABLE', false, 'MIGRATION'
  from public.client c
on conflict do nothing;

alter table public.sales_order
  add column reference_document_type varchar(2);
alter table public.sales_order
  add column reference_document_number varchar(20);

alter table public.sales_order_line
  add column reference_billing_number varchar(20);
alter table public.sales_order_line
  add column reference_billing_line_number integer;

alter table public.sales_order
  drop constraint if exists sales_order_returns_reference_ck;
alter table public.sales_order
  add constraint sales_order_returns_reference_ck
  check (
    (
      document_type = 'RE'
      and reference_document_type is not null
      and reference_document_number is not null
    )
    or (
      document_type <> 'RE'
      and reference_document_type is null
      and reference_document_number is null
    )
  );

alter table public.sales_order_line
  drop constraint if exists sales_order_line_billing_reference_ck;
alter table public.sales_order_line
  add constraint sales_order_line_billing_reference_ck
  check ((reference_billing_number is null) = (reference_billing_line_number is null));

alter table public.sales_order_line
  drop constraint if exists sales_order_line_billing_reference_fk;
alter table public.sales_order_line
  add constraint sales_order_line_billing_reference_fk
  foreign key (client, reference_billing_number)
  references public.billing_document (client, billing_number);

comment on column public.sales_order.reference_document_type is
  'What the order was raised against, as a document type: set on a returns order (RE), empty on every other. Together with reference_document_number it names the invoice the customer is returning goods from.';
comment on column public.sales_order.reference_document_number is
  'The document this order was raised against: the invoice number on a returns order (RE). Null wherever reference_document_type is null.';
comment on column public.sales_order_line.reference_billing_number is
  'The billing document line this item was priced from, on a returns order. The price, the unit, the tax and the material are the ones that line carried, so a later credit memo is priced from what was actually invoiced rather than from a condition record that may since have been renegotiated.';
comment on column public.sales_order_line.reference_billing_line_number is
  'The line of the billing document named in reference_billing_number. Null if and only if that column is null.';
