-- §4.5 (audit gap G2): billing the month — collective billing from the due list.
--
-- Two changes, and the second is the one that matters.
--
-- First, a billing document names an order only where it has one. `order_number`
-- becomes nullable: a collective document bills a month of deliveries and may
-- carry several orders, every one of them named on the line it was priced from,
-- and a header that pretended to an order would be naming one of them and
-- silently billing the others on its authority. SAP's billing header carries no
-- order at all for the same reason — the order is a fact of the item. Every
-- document that stands today was raised against one order and keeps it; nothing
-- is read back differently.
--
-- Second, the split criteria arrive. A collective run groups the due list, and
-- what it groups *by* is a tenant's decision: one invoice per payer, or one per
-- sales organisation, or one per ship-to as well. The three that are not a
-- decision are not here — a billing document posts one receivable, against one
-- payer, in one currency, in one company code — and the five that are, are rows.

-- ── A collective document has no order of its own ─────────────────────────────
alter table public.billing_document alter column order_number drop not null;

comment on column public.billing_document.order_number is
  'The order this billing document was raised against, where it has exactly one. A collective document that bills a month of deliveries carries every order on the line that was priced from it and names none of them here.';

-- ── The split criteria ───────────────────────────────────────────────────────
-- What a collective run separates the due list by. Three criteria always split
-- and stand in no table, because they are not configuration: a receivable is
-- posted against one payer, in one currency, in one company code. These five are
-- the header fields a tenant may say "one invoice per …" about.
create table sales_billing_split_criterion (
  client varchar(4) not null references client (client) on delete cascade,
  criterion varchar(24) not null,
  sequence integer not null default 0,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, criterion),
  constraint sales_billing_split_criterion_code_ck
    check (criterion in ('SALES_ORG', 'DISTRIBUTION_CHANNEL', 'DIVISION', 'SHIP_TO', 'PLANT')),
  constraint sales_billing_split_criterion_sequence_ck check (sequence >= 0)
);

comment on table sales_billing_split_criterion is
  'What a collective billing run splits the due list by. A criterion is a header field of the billing document: where two deliveries of one due list differ in a maintained criterion, they are billed as two documents, and where they differ in a field no criterion names, the value the first delivery of the group carried answers for the whole document. Payer, currency and company code always split and are not maintained here, because one document posts one receivable.';
comment on column sales_billing_split_criterion.criterion is
  'The header field: SALES_ORG, DISTRIBUTION_CHANNEL, DIVISION, SHIP_TO or PLANT.';
comment on column sales_billing_split_criterion.sequence is
  'Where the criterion stands in the group key, so a reader sees the order the split reads them in.';
comment on column sales_billing_split_criterion.is_active is
  'Whether the run splits by it. A withdrawn criterion is kept rather than deleted: what was billed under it stands, and the record of why the month came out as several documents is part of the audit trail.';

alter table sales_billing_split_criterion enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_billing_split_criterion']
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

-- ── The capability ───────────────────────────────────────────────────────────
-- One, because the run itself is billing: it creates and posts billing documents
-- under SALES.BILLING.CREATE. What is maintained here is the decision of how a
-- customer is billed at all — how many invoices one month's deliveries become —
-- and that is configuration a company commits to, not an act on a document.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.SPLIT.DEFINE', 'SALES', 'MAINTAIN', false,
  'Maintain the split criteria a collective billing run uses at /config/billing-split: one invoice per sales organisation, distribution channel, division, ship-to party or shipping plant. A criterion is a header field of the billing document — where two deliveries of one due list differ in one, they are billed as two documents — and where they differ in a field no criterion names, the value the first delivery of the group carried answers for the whole document. Payer, currency and company code always split and are not maintained, because one document posts one receivable. Maintaining a criterion posts nothing and bills nothing; the run that reads them is SALES.BILLING.CREATE.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- ── One line per delivery line, of the delivery it came from ─────────────────
-- The index the package carried keyed on the delivery line number alone, which
-- held while a document billed one delivery and stops holding the moment a
-- collective document bills a month of them: two deliveries, each numbering its
-- own lines from ten, collided on nothing but their line numbers. The delivery
-- joins the key, and the rule it states is unchanged — a document bills a
-- delivery line once.
drop index if exists billing_document_line_delivery_line_uq;

create unique index billing_document_line_delivery_uq
    on billing_document_line (client, billing_number, delivery_number, delivery_line_number)
  where delivery_number is not null;

-- A document raised against a billing plan date names no delivery at all, and
-- what it bills once is the order item. Two plan dates of one item are two
-- documents, as two deliveries of one order are.
create unique index billing_document_line_plan_uq
    on billing_document_line (client, billing_number, order_number, order_line_number)
  where delivery_number is null;
