-- §4.6 (audit gap G2, second half): the customer's invoice — invoice lists.
--
-- SAP's `VF21` groups billing documents that already stand into one invoice to
-- the customer, and `VF24` releases that list to accounting. It is a different
-- act from collective billing, which is why it is a different increment: `VF04`
-- creates documents from what is due, `VF21` groups documents that exist.
--
-- Three things stand here.
--
-- First, **relevance**. SAP lists a document only where both `VBRK-FKART_RL`
-- (the invoice-list type, assigned to the billing type in `OVV7`) and
-- `VBRK-FKDAT_RL` (the invoice-list date, from the **payer master's**
-- invoicing-list dates) were filled on it at creation — `VBUK-RELIK`. Both are
-- stamped here the same way and neither is revised afterwards: a document that
-- was listed does not stop being listed because the payer's schedule changed.
--
-- Second, the **rule that makes it mean something**: a document that is due for
-- a list posts no receivable of its own. It stands OPEN until its list is
-- released, and the release posts one entry for the whole group. That is SAP —
-- a document waiting for a list is not released to accounting — and it is the
-- only shape under which a list is not a second receivable for money the
-- members already owed.
--
-- Third, the **list itself**: a billing document of type `LR` whose items are
-- the members. Stamped `NOT_RELEVANT` on everything that stands today, so
-- nothing that has been billed so far changes and no receivable that has been
-- posted moves.

-- ── What the payer's master says ────────────────────────────────────────────
-- SAP keeps a factory-calendar key on the payer master and reads the list date
-- out of it. The package has no factory calendar, so the period is kept and the
-- list date is computed as the end of the period the billing date falls in.
-- NONE is the default, and it means what an absent calendar means in SAP: this
-- payer's documents are released to accounting on their own.
alter table public.customer_sales_area
  add column invoice_list_schedule varchar(12) not null default 'NONE';

alter table public.customer_sales_area
  add constraint customer_sales_invoice_list_ck
  check (invoice_list_schedule in ('NONE', 'WEEKLY', 'MONTHLY'));

comment on column public.customer_sales_area.invoice_list_schedule is
  'How often this partner''s invoices are grouped onto an invoice list: NONE (released to accounting on their own), WEEKLY or MONTHLY. It is the payer''s field and not the sold-to''s, because an invoice list is made out to the partner who pays.';

-- ── Which billing types are listed, and into what ──────────────────────────
-- SAP's OVV7: assign a billing type to an invoice-list type. Blank on every
-- delivered type, so no document becomes relevant until a tenant says so.
alter table public.sales_document_type
  add column invoice_list_type varchar(4);

alter table public.sales_document_type
  add constraint sales_document_type_invoice_list_fk
  foreign key (client, invoice_list_type)
  references sales_document_type (client, document_type) on delete restrict;

comment on column public.sales_document_type.invoice_list_type is
  'The invoice-list document type a document of this type is grouped into (SAP OVV7). Together with the payer''s schedule it is the whole of invoice-list relevance: a document is listed only where both this and the payer say so.';

-- The type a list is raised as, for every tenant that stands. SAP calls it `LR`;
-- this package spends that code on the returns delivery, so the list is `IL`.
-- It draws from the billing interval, as SAP does: an invoice list is a billing
-- document and is numbered out of the same range as the invoices it groups.
-- Delivered blank as to `invoice_list_type`, which is what keeps this inert: a
-- tenant has to point a billing type at it *and* give a payer a schedule before
-- a single document stops being released to accounting on its own.
insert into sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, is_active, created_by
)
select c.client, 'IL', 'Invoice list', 'BILLING', 'F2', true, 'MIGRATION'
  from client c
on conflict (client, document_type) do nothing;

-- ── What the document carries ──────────────────────────────────────────────
alter table public.billing_document
  add column invoice_list_type varchar(4),
  add column invoice_list_date date,
  add column invoice_list_status varchar(12) not null default 'NOT_RELEVANT',
  add column invoice_list_number varchar(20);

comment on column public.billing_document.invoice_list_type is
  'SAP VBRK-FKART_RL: the invoice-list type this document is grouped into, stamped at creation from the billing document type and never revised.';
comment on column public.billing_document.invoice_list_date is
  'SAP VBRK-FKDAT_RL: the date the invoice list this document belongs on falls, stamped at creation from the payer''s schedule and never revised.';
comment on column public.billing_document.invoice_list_status is
  'NOT_RELEVANT (posts its own receivable), DUE (waiting to be listed, nothing posted) or LISTED (on a list; the list''s release posts the receivable).';

alter table public.billing_document
  add constraint billing_document_invoice_list_relevance_ck
  check ((invoice_list_type is null) = (invoice_list_date is null));

alter table public.billing_document
  add constraint billing_document_invoice_list_status_ck
  check (invoice_list_status in ('NOT_RELEVANT', 'DUE', 'LISTED'));

alter table public.billing_document
  add constraint billing_document_invoice_listed_ck
  check (invoice_list_status <> 'LISTED' or invoice_list_number is not null);

alter table public.billing_document
  add constraint billing_document_invoice_list_fk
  foreign key (client, invoice_list_number)
  references billing_document (client, billing_number) on delete restrict;

alter table public.billing_document
  add constraint billing_document_invoice_list_type_fk
  foreign key (client, invoice_list_type)
  references sales_document_type (client, document_type) on delete restrict;

-- A posted document names the receivable behind it — with two exceptions. A down
-- payment request stands and was sent and posts nothing. And a document on an
-- invoice list posts through the list: the release posts one entry for the whole
-- group, which is the only shape under which a list is not a second receivable.
alter table public.billing_document
  drop constraint if exists billing_document_posted_needs_invoice_ck;

alter table public.billing_document
  add constraint billing_document_posted_needs_invoice_ck
  check (status <> 'POSTED' or document_type = 'DP' or invoice_list_number is not null
         or (customer_invoice_number is not null and journal_document_number is not null));

-- ── The items of a list ────────────────────────────────────────────────────
-- An invoice list is a billing document, but its items are billing documents and
-- not materials: nothing is priced again by it. A separate table, because a
-- billing document line in this package is a priced line of goods and a member
-- row is a reference to another document — one table holding both would
-- describe half its rows wrongly.
create table sales_invoice_list_item (
  client varchar(4) not null references client (client) on delete cascade,
  invoice_list_number varchar(20) not null,
  item_number integer not null,
  billing_number varchar(20) not null,
  net_value numeric(23, 4) not null,
  tax_value numeric(23, 4) not null,
  gross_value numeric(23, 4) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, invoice_list_number, item_number),
  constraint sales_invoice_list_item_list_fk
    foreign key (client, invoice_list_number)
    references billing_document (client, billing_number) on delete cascade,
  constraint sales_invoice_list_item_member_fk
    foreign key (client, billing_number)
    references billing_document (client, billing_number) on delete restrict,
  constraint sales_invoice_list_item_number_ck check (item_number > 0)
);

comment on table sales_invoice_list_item is
  'One billing document on an invoice list (SAP VF21, type LR). The list carries no material, no quantity and no price of its own: each row is a member document and the figures it contributes, written down when the list was created so a list read years later states what it sent the customer for, from rows that have moved since.';

-- A billing document stands on one list at a time, and never twice on the same
-- one. On two lists it would be sent to the customer twice and released to
-- accounting twice, which is the one failure an invoice list must not have.
create unique index sales_invoice_list_item_member_uq
    on sales_invoice_list_item (client, billing_number);
create unique index sales_invoice_list_item_list_member_uq
    on sales_invoice_list_item (client, invoice_list_number, billing_number);

create index sales_invoice_list_item_member_idx
    on sales_invoice_list_item (client, billing_number);

alter table sales_invoice_list_item enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_invoice_list_item']
  loop
    execute format('drop policy if exists %I on %I', table_name || '_tenant', table_name);
    execute format(
      'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      table_name || '_tenant', table_name
    );
    execute format('revoke all on table %I from public', table_name);
    execute format('grant select, insert, update, delete on table %I to cairn_app', table_name);
  end loop;
end $$;

-- ── The capabilities ───────────────────────────────────────────────────────
-- Two, because creating a list and releasing it are not the same act: one groups
-- documents that stand, the other posts the receivable the customer owes for
-- them. SAP keeps them apart too — `VF21` creates, `VF24` releases — and a
-- single authority would let whoever groups a month also post it.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.INVOICE_LIST.CREATE', 'SALES', 'INVOICE_LIST', false,
  'Group a payer''s billing documents onto an invoice list at /sales/invoice-lists (SAP VF21, billing type LR): the documents that already stand and are due for a list, grouped by payer, company code, currency and invoice-list date. An invoice list is itself a billing document whose items are the documents it groups; nothing is priced again by it, and creating one posts nothing. Relevance for a list is stamped on the document the day it is billed, from the billing type and the payer''s schedule, and is never revised. Releasing the list to accounting is SALES.INVOICE_LIST.RELEASE.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.INVOICE_LIST.RELEASE', 'SALES', 'INVOICE_LIST', true,
  'Release an invoice list to accounting at /sales/invoice-lists (SAP VF24). The act that posts: one receivable for the whole list, against the payer it names, raised by the accounting-invoice service under a key that makes a retry raise no second one. Until it is released, a document on the list has posted nothing at all — which is what keeps a list from being a second receivable for money its members already owed. Grouping the documents is SALES.INVOICE_LIST.CREATE.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
