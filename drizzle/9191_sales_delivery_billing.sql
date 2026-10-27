-- The outbound delivery, its picking, and the billing document the delivered quantity earns.
--
-- CAIRN.md §20 names this second half of the sales document chain (LIKP/LIPS and VBRK/VBRP) and §11.2
-- states what each step posts: the delivery moves nothing on its own, the pick confirms what the store
-- has taken to the loading dock, the goods issue is the movement that leaves the plant and values itself
-- at the material's own price, and the billing document is what creates the receivable. This migration
-- carries those three documents. It adds no order or price column: the order and the condition record
-- stand from 9190, and the value an invoice carries is read from the order line the delivery came from,
-- so an invoice cannot disagree with the order it fulfils (§11.2).
--
-- Why the goods issue is not a table here: §5.1 is explicit that "a goods receipt in Inventory and a
-- goods issue in Sales both go through the same material-document engine". The delivery therefore stores
-- the number of the material document its posting created and nothing else about the movement — no
-- quantity counter pretending to be the ledger, no valuation copy. The quantity that left the plant is
-- read from the material document line, and the movement that posted it is the goods-issue service's own
-- scenario for screen 'SALES' (see src/modules/inventory/goods-issue.ts).
--
-- What is deliberately NOT here, because nothing would read it: packing and handling units
-- (SALES.DELIVERY.PACK), returns and the credit/debit memo paths (SALES.RETURNS.CREATE,
-- SALES.CREDITMEMO.CREATE), the collective and delivery-due worklists (VL10, VF04), and the delivery
-- scheduling block reason. Each needs either a master or a posting path that does not exist yet; they are
-- recorded in docs/DEFERRED_ISSUES.md rather than stored as unread columns.
--
-- One billing document per delivery, and one billing line per delivery line, are enforced by unique
-- indexes rather than by a service that hopes to be the only writer: overbilling a delivered line becomes
-- structurally impossible, and a concurrent or retried billing loses on the index and is reported as the
-- duplicate it is. A cancelled billing keeps both rows, so the re-bill of a cancelled invoice is refused
-- by name and points at the memo path that has to be built first (DI-020).
--
-- Quantities a follow-on document has advanced are never stored on the document they advanced. The order
-- line keeps its ordered quantity alone; what stands delivered is the sum of the delivery lines that
-- reference it, and what stands billed is the sum of the billing lines that reference the delivery. A
-- delivery line's own remaining_quantity is the one arithmetic exception, because over-delivery of an
-- order is refused at entry and the database, not only the form, has to hold that line.

-- The table comments follow the DDL: a comment on a relation that does not exist yet is an error,
-- and this file creates five of them below.


create table if not exists public.delivery (
  client varchar(4) not null references public.client (client) on delete cascade,
  delivery_number varchar(20) not null,
  document_type varchar(2) not null default 'LF',
  order_number varchar(20) not null,
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  division varchar(2) not null,
  customer_number varchar(40) not null,
  company_code varchar(10) not null,
  plant varchar(10) not null,
  delivery_date date not null,
  goods_movement_date date,
  -- OPEN takes picks; PICKED is complete and may be goods-issued; GOODS_ISSUED is the state a material
  -- document earned; CANCELLED is reachable only while nothing has moved out of the store.
  status varchar(16) not null default 'OPEN',
  material_document_number varchar(20),
  material_document_year integer,
  header_text varchar(100),
  version integer not null default 1,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, delivery_number),
  constraint delivery_status_ck check (status in ('OPEN', 'PICKED', 'GOODS_ISSUED', 'CANCELLED')),
  constraint delivery_version_ck check (version > 0),
  constraint delivery_type_ck check (document_type ~ '^[A-Z0-9]{2}$'),
  constraint delivery_date_ck check (goods_movement_date is null or goods_movement_date >= delivery_date),
  -- A delivery that calls itself goods-issued names the material document that did it. There is no way
  -- to reach the status without the link, and no way to keep the status after the document is gone.
  constraint delivery_issued_needs_document_ck
    check (status <> 'GOODS_ISSUED' or (material_document_number is not null and material_document_year is not null)),
  constraint delivery_order_fk
    foreign key (client, order_number) references public.sales_order (client, order_number) on delete cascade,
  constraint delivery_customer_fk
    foreign key (client, customer_number) references public.business_partner (client, partner_number) on delete cascade,
  constraint delivery_area_fk
    foreign key (client, sales_org, distribution_channel, division)
    references public.sales_area (client, sales_org, distribution_channel, division) on delete cascade,
  constraint delivery_company_fk
    foreign key (client, company_code) references public.company_code (client, company_code) on delete cascade,
  constraint delivery_material_document_fk
    foreign key (client, material_document_number)
    references public.material_document (client, material_document_number) on delete cascade
);

create unique index if not exists delivery_request_key_uq
  on public.delivery (client, request_key) where request_key is not null;
create index if not exists delivery_order_idx on public.delivery (client, order_number);

create table if not exists public.delivery_line (
  client varchar(4) not null,
  delivery_number varchar(20) not null,
  line_number integer not null,
  order_number varchar(20) not null,
  order_line_number integer not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  -- No storage location and no batch on the line: the pick rows below state where the goods came from and
  -- in which batch, and the goods issue posts one movement line per (location, batch) the picks name. A
  -- copy of that figure on the line would be a second answer to the same question.
  quantity_unit char(6) not null,
  -- What the order line asked for, what stood delivered before this document, what this document carries,
  -- and what is left. All four stay on the row because the refusal has to be readable from the delivery
  -- alone: "you cannot deliver 60 of an order line of 100 that already had 50 out" is not reconstructable
  -- from a single number.
  ordered_quantity numeric(13, 3) not null,
  delivered_before numeric(13, 3) not null default 0,
  delivery_quantity numeric(13, 3) not null,
  remaining_quantity numeric(13, 3) not null,
  picked_quantity numeric(13, 3) not null default 0,
  goods_issue_quantity numeric(13, 3) not null default 0,
  status varchar(16) not null default 'OPEN',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, delivery_number, line_number),
  constraint delivery_line_status_ck check (status in ('OPEN', 'PICKED', 'GOODS_ISSUED')),
  constraint delivery_line_number_ck check (line_number > 0 and order_line_number > 0),
  constraint delivery_line_quantity_ck
    check (ordered_quantity > 0 and delivery_quantity > 0 and delivered_before >= 0),
  -- The over-delivery refusal, in the database: a line cannot carry more than its order line still had open.
  constraint delivery_line_remaining_ck
    check (remaining_quantity = ordered_quantity - delivered_before - delivery_quantity and remaining_quantity >= 0),
  constraint delivery_line_picked_ck check (picked_quantity >= 0 and picked_quantity <= delivery_quantity),
  constraint delivery_line_issued_ck check (goods_issue_quantity >= 0 and goods_issue_quantity <= picked_quantity),
  -- Goods issue posts the picked quantity in full: an incomplete pick does not earn a movement.
  constraint delivery_line_issue_completeness_ck
    check (
      status <> 'GOODS_ISSUED'
      or (picked_quantity = delivery_quantity and goods_issue_quantity = delivery_quantity)
    ),
  constraint delivery_line_delivery_fk
    foreign key (client, delivery_number) references public.delivery (client, delivery_number) on delete cascade,
  constraint delivery_line_order_line_fk
    foreign key (client, order_number, order_line_number)
    references public.sales_order_line (client, order_number, line_number) on delete cascade,
  constraint delivery_line_material_fk
    foreign key (client, material_number) references public.material (client, material_number) on delete cascade,
  constraint delivery_line_unit_fk
    foreign key (quantity_unit) references public.unit_of_measure (code) on delete cascade
);

create table if not exists public.delivery_picking (
  client varchar(4) not null,
  delivery_number varchar(20) not null,
  line_number integer not null,
  pick_number integer not null,
  -- Signed on purpose. The history is append-only, so a correcting row is the only way to answer a
  -- confirmation that was wrong, and a row that changes nothing is not worth keeping.
  quantity_delta numeric(13, 3) not null,
  storage_location varchar(10) not null,
  batch_number varchar(40) not null default '',
  reason varchar(60),
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  primary key (client, delivery_number, line_number, pick_number),
  constraint delivery_picking_number_ck check (pick_number > 0),
  constraint delivery_picking_delta_ck check (quantity_delta <> 0),
  constraint delivery_picking_delivery_line_fk
    foreign key (client, delivery_number, line_number)
    references public.delivery_line (client, delivery_number, line_number) on delete cascade
);

create unique index if not exists delivery_picking_request_key_uq
  on public.delivery_picking (client, request_key) where request_key is not null;

create table if not exists public.billing_document (
  client varchar(4) not null,
  billing_number varchar(20) not null,
  document_type varchar(2) not null default 'F2',
  order_number varchar(20) not null,
  delivery_number varchar(20) not null,
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  division varchar(2) not null,
  customer_number varchar(40) not null,
  company_code varchar(10) not null,
  currency char(3) not null,
  billing_date date not null,
  posting_date date,
  -- OPEN is a document whose accounting entry did not stand (a refused posting leaves it here to retry);
  -- POSTED names the accounting document; CANCELLED is what the invoice cancellation leaves behind.
  status varchar(16) not null default 'OPEN',
  net_value numeric(23, 4) not null default 0,
  tax_value numeric(23, 4) not null default 0,
  gross_value numeric(23, 4) not null default 0,
  -- Both halves of the receivable are named: the invoice the accounting service created, which is what a
  -- cancellation addresses, and the journal document it posted.
  customer_invoice_number varchar(20),
  journal_document_number varchar(20),
  reference_document_text varchar(100),
  version integer not null default 1,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, billing_number),
  constraint billing_document_status_ck check (status in ('OPEN', 'POSTED', 'CANCELLED')),
  constraint billing_document_version_ck check (version > 0),
  constraint billing_document_type_ck check (document_type ~ '^[A-Z0-9]{2}$'),
  constraint billing_document_value_ck check (net_value >= 0 and tax_value >= 0 and gross_value >= 0),
  -- The status that says the customer owes the money is the one the invoice and its journal have to back up.
  constraint billing_document_posted_needs_invoice_ck
    check (status <> 'POSTED' or (customer_invoice_number is not null and journal_document_number is not null)),
  constraint billing_document_date_ck check (posting_date is null or posting_date >= billing_date),
  constraint billing_document_delivery_fk
    foreign key (client, delivery_number) references public.delivery (client, delivery_number) on delete cascade,
  constraint billing_document_order_fk
    foreign key (client, order_number) references public.sales_order (client, order_number) on delete cascade,
  constraint billing_document_customer_fk
    foreign key (client, customer_number) references public.business_partner (client, partner_number) on delete cascade,
  constraint billing_document_area_fk
    foreign key (client, sales_org, distribution_channel, division)
    references public.sales_area (client, sales_org, distribution_channel, division) on delete cascade,
  constraint billing_document_company_fk
    foreign key (client, company_code) references public.company_code (client, company_code) on delete cascade,
  constraint billing_document_currency_fk
    foreign key (currency) references public.currency (code) on delete cascade
);

-- One billing document per delivery, ever. A retry replays on the request key; a second attempt to bill
-- the same delivery loses on this index and is reported as the duplicate it is. Re-billing after a
-- cancellation needs the memo path first, and the refusal says so.
create unique index if not exists billing_document_delivery_uq
  on public.billing_document (client, delivery_number);
create unique index if not exists billing_document_request_key_uq
  on public.billing_document (client, request_key) where request_key is not null;
create index if not exists billing_document_order_idx on public.billing_document (client, order_number);

create table if not exists public.billing_document_line (
  client varchar(4) not null,
  billing_number varchar(20) not null,
  line_number integer not null,
  delivery_number varchar(20) not null,
  delivery_line_number integer not null,
  order_number varchar(20) not null,
  order_line_number integer not null,
  material_number varchar(40) not null,
  billing_quantity numeric(13, 3) not null,
  -- Price and provenance come from the order line, never from the form: what the customer was charged and
  -- which condition record answered it are the same two answers on the invoice as on the order.
  net_price numeric(23, 4) not null,
  price_unit integer not null default 1,
  net_amount numeric(23, 4) not null,
  tax_code varchar(4),
  tax_rate numeric(7, 4) not null default 0,
  tax_amount numeric(23, 4) not null default 0,
  condition_number varchar(18) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  primary key (client, billing_number, line_number),
  constraint billing_document_line_number_ck check (line_number > 0 and delivery_line_number > 0),
  constraint billing_document_line_quantity_ck check (billing_quantity > 0 and price_unit > 0),
  constraint billing_document_line_amount_ck check (net_price >= 0 and net_amount >= 0 and tax_amount >= 0),
  -- The line amount is the price applied to the quantity, at the record's own price unit.
  constraint billing_document_line_amount_math_ck
    check (abs(net_amount - (billing_quantity * net_price / price_unit)) < 0.005),
  constraint billing_document_line_billing_fk
    foreign key (client, billing_number) references public.billing_document (client, billing_number) on delete cascade,
  constraint billing_document_line_delivery_line_fk
    foreign key (client, delivery_number, delivery_line_number)
    references public.delivery_line (client, delivery_number, line_number) on delete cascade,
  constraint billing_document_line_order_line_fk
    foreign key (client, order_number, order_line_number)
    references public.sales_order_line (client, order_number, line_number) on delete cascade,
  constraint billing_document_line_material_fk
    foreign key (client, material_number) references public.material (client, material_number) on delete cascade,
  -- The condition record a billed line priced from is kept by the invoice, exactly as the order line keeps
  -- it: a price the customer was charged for cannot be dropped out from under the invoice that names it.
  constraint billing_document_line_condition_fk
    foreign key (client, condition_number)
    references public.sales_condition_record (client, condition_number) on delete restrict
);

-- A delivered line is billed once. This is the overbilling guard, and it is the reason a concurrent second
-- attempt on the same delivery cannot quietly split its quantity across two documents.
create unique index if not exists billing_document_line_delivery_line_uq
  on public.billing_document_line (client, delivery_number, delivery_line_number);

-- Rights, stated per table as the grant policy requires (docs/migration-authoring.md). The delivery and its
-- items are documents their own service advances; the pick history and the billing lines are written once
-- and never amended, so their mutation rights are taken away rather than promised away in a comment.
comment on table public.delivery is
  'Outbound delivery header — LIKP. CAIRN.md §14.7 and the delivery row of §20. Created from open order quantities, priced nowhere, posting nothing until its goods issue names a material document; check points of the credit ladder stand at its creation (D-029).';
comment on table public.delivery_line is
  'One item of an outbound delivery — LIPS. Ordered, already-delivered and remaining quantities are carried on the line so the over-delivery refusal is visible in the row, and picked and issued quantities move only with the confirmation and the posting that caused them.';
comment on table public.delivery_picking is
  'A picking confirmation against one delivery item — the VBPB/LIPS picking history. Append-only by design: a mistaken confirmation is answered by a correcting row of the opposite sign, which is what keeps the pick auditable and what stops a pick from silently rewriting the past.';
comment on table public.billing_document is
  'Billing document header — VBRK. Posts the receivable through the accounting-invoice service (FIN.AR.INVOICE.POST) and keeps the accounting document it created, so the link is two-way; the invoice status is the only thing that may call itself POSTED, and it cannot until the accounting document stands.';
comment on table public.billing_document_line is
  'One item of a billing document — VBRP. The quantity is what was goods-issued on the delivery item it names, the price and the condition record are read from the order line behind it, and a delivered line can be billed once (billing_document_line_delivery_line_uq).';

grant select, insert, update, delete on table public.delivery to cairn_app;
grant select, insert, update, delete on table public.delivery_line to cairn_app;
grant select, insert, update, delete on table public.billing_document to cairn_app;

revoke update, delete, truncate on table public.delivery_picking from cairn_app;
revoke update, delete, truncate on table public.billing_document_line from cairn_app;

revoke all on table public.delivery from public;
revoke all on table public.delivery_line from public;
revoke all on table public.delivery_picking from public;
revoke all on table public.billing_document from public;
revoke all on table public.billing_document_line from public;

-- All five are tenant-scoped, so each carries the forced policy the platform's withTenant sets are judged
-- by (D-041). A table without it would read across clients.
do $$
declare
  target text;
begin
  foreach target in array array[
    'delivery', 'delivery_line', 'delivery_picking', 'billing_document', 'billing_document_line'
  ]
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);
    execute format(
      'create policy tenant_isolation on public.%I using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      target
    );
  end loop;
end $$;

-- The five sales codes CAIRN.md §14.7 lists for this stretch of the chain were registered as names only.
-- A capability the authorization object does not hold cannot be granted to a role, so the row is what
-- makes the screen reachable; each description states the engine the act runs through, because the screen
-- posts through someone else's invariant.
insert into capability (code, module, action, is_posting_relevant, description)
values
  (
    'SALES.DELIVERY.CREATE', 'SALES', 'CREATE', false,
    'Create and cancel an outbound delivery from open sales order quantities at /sales/delivery. A delivery moves no stock and posts nothing; its goods issue is a separate act under SALES.GI.POST.'
  ),
  (
    'SALES.DELIVERY.PICK', 'SALES', 'CONFIRM', false,
    'Confirm picking against a delivery item at /sales/delivery. The row is appended to the pick history and moves no stock; a correction is a row of the opposite sign.'
  ),
  (
    'SALES.GI.POST', 'SALES', 'POST', true,
    'Post the goods issue of a picked delivery at /sales/delivery. The movement runs through the inventory goods-issue engine, so stock, valuation and the journal commit in the same transaction as the delivery status.'
  ),
  (
    'SALES.BILLING.CREATE', 'SALES', 'POST', true,
    'Create a billing document from the goods-issued quantity of a delivery at /sales/billing. The receivable is posted by the accounting-invoice service, and the billing document keeps the accounting document it created.'
  ),
  (
    'SALES.BILLING.CANCEL', 'SALES', 'CANCEL', true,
    'Cancel a billing document at /sales/billing. The accounting entry is reversed by the invoice cancellation, which is the only way a posted receivable leaves the customer account.'
  )
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- An order the chain has already touched is no longer the order's own to rewrite: the description of the
-- order code now states the boundary the fulfillment service enforces.
update capability
   set description = 'Create, change and cancel a sales order at /sales/orders. The item price is read from a standing condition record maintained at /sales/conditions and never from the form, and the credit determination the save raises is what blocks the order for delivery. An order line a delivery has drawn on cannot be reduced below the delivered quantity or rejected, and an order with a delivery cannot be cancelled.'
 where code = 'SALES.ORDER.CREATE';

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'SALES.DELIVERY.CREATE',
  'delivery',
  'Outbound delivery',
  'TRANSACTION',
  'SD',
  $dl9$The shipment the warehouse makes for an order: a delivery is created from the open quantity of an order line, picked, and then goods-issued through the inventory movement engine. VL01N, VL02N and VL10 are search aliases of this screen. A delivery on its own posts nothing and moves nothing; the credit check that blocks an order also refuses its delivery.$dl9$,
  'TIER_1_LIVE',
  '/sales/delivery',
  'B',
  'MIGRATION_9191'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9191',
  changed_at = now();

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'SALES.BILLING.CREATE',
  'billing_document',
  'Billing document',
  'TRANSACTION',
  'SD',
  $bl9$The invoice a goods-issued delivery earns: the quantity is what left the plant, the price and the condition record are read from the order line, and the receivable is posted by the accounting-invoice service in the customer's own company code. VF01, VF02, VF04 and VF11 are search aliases of this screen. A delivered line can be billed once.$bl9$,
  'TIER_1_LIVE',
  '/sales/billing',
  'B',
  'MIGRATION_9191'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9191',
  changed_at = now();
