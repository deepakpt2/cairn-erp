-- 9226: a sales document type is configuration, not a constant.
--
-- The chain has carried three hard-coded document types since it was built: `OR`, `LF` and `F2`, written
-- straight into sales-order.ts, delivery.ts and billing.ts as SALES_ORDER_TYPE, DELIVERY_TYPE and
-- BILLING_TYPE. Each constant is really three facts wearing one name — the code a document carries, the
-- number range object and sub-object its number is drawn from, and the name a screen shows — and a fourth
-- fact is missing from all three: whether the type is still in use at all. A new commercial process has
-- therefore cost a deployment rather than a configuration, which inverts how the rest of this system is
-- built: movement types, purchasing contract types and scheduling agreement types are all rows, and the
-- sales chain is the exception.
--
-- SAP holds the same idea in three places — VOV8 for sales orders, the delivery type and the billing type —
-- and each entry carries the number range, the proposed follow-on types and the cancellation type that let
-- the chain walk itself. This migration carries the table those entries live in, and seeds the three types
-- the chain uses today.
--
-- It adds only what is read. The code, the name, the number range the document draws its number from, and
-- whether the type stands: each of those is read by the service that creates the document. Deliberately
-- absent, because nothing reads them and an unread column is a promise the system does not keep: the
-- cancellation billing type, the proposed delivery and billing types of a type, the item category
-- determination, and the pricing and partner procedure keys. Each arrives with the increment that reads it,
-- in its own migration, tested against its own reader.
--
-- The three types are seeded for every tenant that already stands, and for every tenant created from now on
-- in src/platform/tenancy/index.ts — beside the number ranges those same types draw from, which is where the
-- purchasing contract and scheduling agreement types are seeded already. A document whose type is not
-- configured is refused by name rather than defaulted: the number range is read from the row, so a missing
-- row would otherwise present as a missing number, and a silence in the wrong place is how a document comes
-- to carry a number out of the wrong interval.
--
-- The application role reads this table and does not write it. There is no maintenance screen yet, so the
-- grant is SELECT alone; the increment that adds the screen grants the rest, and the privilege audit that
-- runs with the migrations is what keeps that honest.
--
-- The three document columns widen from two characters to four in the same breath. SAP's own types need the
-- room — the down payment request is FAZ and its cancellation FAS, the intercompany billing type is IV — and
-- a configuration table that could hold a code no document is able to carry would be a table that lies about
-- what it can do. Raising a varchar limit rewrites no rows, so the widening costs nothing now and saves a
-- later migration from having to move documents to do it.

create table public.sales_document_type (
  client                  varchar(4)  not null references public.client (client) on delete cascade,
  document_type           varchar(4)  not null,
  name                    varchar(40) not null,
  number_range_object     varchar(10) not null,
  number_range_sub_object varchar(10) not null,
  is_active               boolean     not null default true,
  created_by              varchar(60) not null default 'SYSTEM',
  created_at              timestamptz not null default now(),
  changed_by              varchar(60),
  changed_at              timestamptz,
  primary key (client, document_type)
);

comment on table public.sales_document_type is
  'A sales document type — VOV8, the delivery type and the billing type in one table, because all three are the same thing: a code a document carries, the number range its number is drawn from, and whether it may still be used. Seeded with OR, LF and F2 for every tenant; a document whose type does not stand here is refused, not defaulted.';
comment on column public.sales_document_type.document_type is
  'The code the document carries in sales_order, delivery or billing_document. Up to four characters, because the down payment (FAZ) and intercompany (IV) types need them.';
comment on column public.sales_document_type.number_range_object is
  'The number range object the document number is drawn from: SALESORD for an order, DELIVERY for a delivery, BILLING for a billing document.';
comment on column public.sales_document_type.number_range_sub_object is
  'The sub-object inside that object — OR, LF, F2 — which is what lets one object carry several types without their interleaving.';
comment on column public.sales_document_type.is_active is
  'Whether documents of this type may still be created. A type with documents standing under it is deactivated rather than deleted, so the history keeps reading.';

-- Every tenant that already stands gets the three types the chain has been hard-coding, so a database
-- migrated today behaves exactly as it did yesterday.
insert into public.sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, created_by
)
select c.client, v.document_type, v.name, v.number_range_object, v.number_range_sub_object, 'MIGRATION'
  from public.client c
  cross join (
    values ('OR', 'Standard order',    'SALESORD', 'OR'),
           ('LF', 'Outbound delivery', 'DELIVERY', 'LF'),
           ('F2', 'Invoice',           'BILLING',  'F2')
  ) as v (document_type, name, number_range_object, number_range_sub_object)
on conflict (client, document_type) do nothing;

-- The document columns widen to the four characters the configuration table allows.
alter table public.sales_order      alter column document_type type varchar(4);
alter table public.delivery         alter column document_type type varchar(4);
alter table public.billing_document alter column document_type type varchar(4);

grant select on table public.sales_document_type to cairn_app;
revoke all on table public.sales_document_type from public;

-- Tenant-scoped, so it carries the forced policy the platform's withTenant sets are judged by (D-041).
alter table public.sales_document_type enable row level security;
alter table public.sales_document_type force row level security;
create policy tenant_isolation on public.sales_document_type
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
