-- The returns delivery: the document that drives a customer return.
--
-- Until now a return has been posted by calling a service against an outbound delivery. That works,
-- and it is not how SAP does it, and the difference matters the moment anything else has to refer to
-- the return: a credit memo has something to name, a document flow has something to draw, and the
-- quantity that came back belongs to a document of its own rather than to a column on the delivery
-- the goods left on. SAP's returns delivery is LR, created with reference to what went out, and it
-- is what posts movement 651.
--
-- Three facts are added here.
--
-- The first two are the type and its interval, seeded for every tenant that already stands — the
-- catalogue in code covers tenants created from now on, and this covers the ones that do not.
--
-- The third is the shape of the document. A returns delivery names the delivery it came back
-- against, which is what makes "how much may come back" answerable from the document itself. It can
-- be RECEIVED, which no other delivery can: goods arriving are not goods issued, and giving the
-- inbound movement the outbound status would let every screen that reads GOODS_ISSUED treat goods
-- coming in as goods going out. A received returns delivery carries its material document, exactly
-- as an issued delivery does — a document that moved stock and cannot name the movement is a
-- document nobody can audit. And a delivery either is a return, naming its origin, or is not one and
-- names nothing; there is no third state in which the reference is decoration.

insert into public.sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, created_by
)
select c.client, 'LR', 'Returns delivery', 'DELIVERY', 'LR', 'MIGRATION'
  from public.client c
on conflict (client, document_type) do nothing;

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'DELIVERY', '*', 'LR', 0, 'RT', 1, 999999, 0, 7, 'READABLE', false, 'MIGRATION'
  from public.client c
on conflict do nothing;

alter table public.delivery
  add column reference_delivery_number varchar(20);

alter table public.delivery
  add constraint delivery_reference_delivery_fk
  foreign key (client, reference_delivery_number)
  references public.delivery (client, delivery_number);

alter table public.delivery
  drop constraint if exists delivery_status_ck;
alter table public.delivery
  add constraint delivery_status_ck
  check (status in ('OPEN', 'PICKED', 'GOODS_ISSUED', 'CANCELLED', 'RECEIVED'));

alter table public.delivery_line
  drop constraint if exists delivery_line_status_ck;
alter table public.delivery_line
  add constraint delivery_line_status_ck
  check (status in ('OPEN', 'PICKED', 'GOODS_ISSUED', 'RECEIVED'));

alter table public.delivery
  drop constraint if exists delivery_received_needs_document_ck;
alter table public.delivery
  add constraint delivery_received_needs_document_ck
  check (
    status <> 'RECEIVED'
    or (material_document_number is not null and material_document_year is not null)
  );

alter table public.delivery
  drop constraint if exists delivery_returns_reference_ck;
alter table public.delivery
  add constraint delivery_returns_reference_ck
  check ((document_type = 'LR') = (reference_delivery_number is not null));

comment on column public.delivery.reference_delivery_number is
  'Set only on a returns delivery (LR): the delivery the goods went out on and are coming back against. Every quantity that has come back is answerable from this document and from the returned_quantity on the lines it names.';
