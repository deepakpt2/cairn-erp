-- The credit memo request: the complaint, held until somebody releases it.
--
-- A credit memo is something the company gives away, so SAP does not let one be raised straight from
-- a conversation: the complaint is recorded first, as a credit memo request, and that request stands
-- blocked for billing until somebody with the authority to give the money away releases it. The gap
-- this closes is not the document — it is the act between asking and giving.
--
-- Two facts are added here.
--
-- The first two are the type and its interval, seeded for every tenant that already stands — the
-- catalogue in code covers tenants created from now on, and this covers the ones that do not.
--
-- The third is the block itself, on the order where SAP carries it. It holds why the document is
-- held: an empty string would be a document that is blocked for no reason anybody can read, which is
-- how a block becomes a habit rather than a decision. Null means released, and that is the only
-- state in which the request can be credited.

insert into public.sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, created_by
)
select c.client, 'CR', 'Credit memo request', 'SALESORD', 'CR', 'MIGRATION'
  from public.client c
on conflict (client, document_type) do nothing;

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'SALESORD', '*', 'CR', 0, 'CR', 1, 999999, 0, 7, 'READABLE', false, 'MIGRATION'
  from public.client c
on conflict do nothing;

alter table public.sales_order
  add column billing_block varchar(60);

alter table public.sales_order
  drop constraint if exists sales_order_billing_block_ck;
alter table public.sales_order
  add constraint sales_order_billing_block_ck
  check (billing_block is null or btrim(billing_block) <> '');

comment on column public.sales_order.billing_block is
  'Why this document is held from billing; null when it stands released. A credit memo request is created held, and no credit memo is raised against it until it is released — the act between asking for the credit and giving the money away.';

-- The order reference was written when the returns order was the only order raised against another
-- document, so it said: an RE names the invoice it came from, and every other order names nothing.
-- The credit memo request is the second kind of order that is raised against one, and the rule was
-- never really about the returns order — it is about an order that answers another document. So it is
-- restated here as it should have been: the two complaint documents name what they were raised
-- against, an order that was not raised against anything names nothing, and no document names a
-- reference that is decoration.
alter table public.sales_order
  drop constraint if exists sales_order_returns_reference_ck;
alter table public.sales_order
  add constraint sales_order_reference_ck
  check (
    (
      document_type in ('RE', 'CR')
      and reference_document_type is not null
      and reference_document_number is not null
    )
    or (
      document_type not in ('RE', 'CR')
      and reference_document_type is null
      and reference_document_number is null
    )
  );
