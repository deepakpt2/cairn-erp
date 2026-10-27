-- Sales orders, and the condition record an order price is read from.
--
-- CAIRN.md §20 names the sales document chain (VBAK/VBAP, LIKP/LIPS, VBRK/VBRP) and §11.2 states what
-- each step posts. This migration carries the first link only: the order, its items, and the one
-- master the order cannot do without — the price. Nothing here is a placeholder for a later link: the
-- outbound delivery, its picking, the goods issue and the billing document arrive with their own
-- migration and their own postings, and the quantities a follow-on document advances (delivered,
-- billed) are added there rather than sitting here unread.
--
-- Why a condition record belongs to this migration at all: CAIRN.md §11.2 requires the order and the
-- invoice to price consistently, and a figure typed into an order form satisfies neither the auditors
-- who ask what a customer was quoted nor the invoice that has to match the order it came from. So the
-- price is read from a standing record for the sales area, the customer and the material over a
-- validity period, and the record that answered is named on the line.
--
-- What is deliberately NOT here, because nothing would read it: the pricing-procedure table and its
-- steps. The customer master's pricing_procedure column stays unread by an order — as it is today —
-- until there is a procedure to resolve and a screen that maintains it. Recording procedures, access
-- sequences, scales, header conditions and the freight and discount step types as deferred is honest;
-- storing three tables that only a test would write is not. See DI-018.
--
-- Credit control adds no column. src/modules/finance/credit.ts already records one determination per
-- sales document and /finance/credit-release already claims them, so an order's blocking state is the
-- determination that stands against its number — never a copy of it on the order.

create table if not exists public.sales_order (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(20) not null,
  document_type varchar(2) not null default 'OR',
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  division varchar(2) not null,
  customer_number varchar(40) not null,
  company_code varchar(10) not null,
  currency char(3) not null,
  order_date date not null,
  requested_date date,
  purchase_order_reference varchar(20),
  header_text varchar(100),
  -- OPEN takes changes; CANCELLED is the order's own last word. A delivery that has read the order
  -- will make the cancellation refuse, and that check arrives with the delivery.
  status varchar(16) not null default 'OPEN',
  net_value numeric(23, 4) not null default 0,
  tax_value numeric(23, 4) not null default 0,
  gross_value numeric(23, 4) not null default 0,
  version integer not null default 1,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number),
  constraint sales_order_status_ck check (status in ('OPEN', 'CANCELLED')),
  constraint sales_order_version_ck check (version > 0),
  constraint sales_order_value_ck check (net_value >= 0 and tax_value >= 0 and gross_value >= 0),
  constraint sales_order_date_ck check (requested_date is null or requested_date >= order_date),
  constraint sales_order_type_ck check (document_type ~ '^[A-Z0-9]{2}$'),
  constraint sales_order_customer_fk
    foreign key (client, customer_number) references public.business_partner (client, partner_number) on delete cascade,
  constraint sales_order_area_fk
    foreign key (client, sales_org, distribution_channel, division)
    references public.sales_area (client, sales_org, distribution_channel, division) on delete cascade,
  constraint sales_order_company_fk
    foreign key (client, company_code) references public.company_code (client, company_code) on delete cascade,
  -- A currency is client-independent configuration; deleting one is not something a tenant cascade
  -- does, so the reference simply stands.
  constraint sales_order_currency_fk
    foreign key (currency) references public.currency (code) on delete cascade
);

-- A retry of the same submission replays to the order the first attempt created; the key is not
-- unique when it is absent, so an order created by hand is never bound to a request.
create unique index if not exists sales_order_request_key_uq
  on public.sales_order (client, request_key) where request_key is not null;
create index if not exists sales_order_customer_idx
  on public.sales_order (client, customer_number, status, order_date);
create index if not exists sales_order_area_idx
  on public.sales_order (client, sales_org, status);

comment on table public.sales_order is
  'Sales order header — the customer''s commitment, reference field set VBAK. Created at /sales/orders under SALES.ORDER.CREATE; it reserves nothing and posts no accounting document. The credit determination that stands against this number is what blocks it. Reference: CAIRN.md §11.2 row 3.';
comment on column public.sales_order.gross_value is
  'Net plus tax over the items that are not rejected, in the order currency. The credit check reads this figure, which is why a change recomputes it instead of leaving the header total as it was.';
comment on column public.sales_order.status is
  'OPEN or CANCELLED, written by this module alone. A follow-on document will refuse the cancellation, and that check arrives with the documents that follow.';

create table if not exists public.sales_order_line (
  client varchar(4) not null,
  order_number varchar(20) not null,
  line_number integer not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  order_quantity numeric(13, 3) not null,
  quantity_unit char(6) not null,
  base_quantity numeric(13, 3) not null,
  net_price numeric(23, 4) not null default 0,
  price_unit integer not null default 1,
  net_amount numeric(23, 4) not null default 0,
  tax_code varchar(4),
  tax_rate numeric(7, 4) not null default 0,
  tax_amount numeric(23, 4) not null default 0,
  profit_center varchar(20),
  requested_delivery_date date,
  condition_number varchar(18) not null,
  status varchar(16) not null default 'OPEN',
  rejection_reason varchar(4),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, order_number, line_number),
  constraint sales_order_line_order_fk
    foreign key (client, order_number) references public.sales_order (client, order_number) on delete cascade,
  constraint sales_order_line_material_fk
    foreign key (client, material_number) references public.material (client, material_number) on delete cascade,
  constraint sales_order_line_unit_fk
    foreign key (quantity_unit) references public.unit_of_measure (code) on delete cascade,
  constraint sales_order_line_quantity_ck check (order_quantity > 0 and base_quantity > 0),
  constraint sales_order_line_price_ck check (net_price >= 0 and price_unit > 0 and net_amount >= 0),
  constraint sales_order_line_tax_ck check (tax_rate >= 0 and tax_amount >= 0),
  constraint sales_order_line_status_ck check (status in ('OPEN', 'REJECTED')),
  -- A rejected item keeps its row and its reason; the reason is what makes the rejection readable.
  constraint sales_order_line_rejection_ck
    check ((status = 'REJECTED' and rejection_reason is not null) or (status = 'OPEN' and rejection_reason is null)),
  constraint sales_order_line_number_ck check (line_number > 0)
);

create index if not exists sales_order_line_material_idx
  on public.sales_order_line (client, material_number, plant);

comment on table public.sales_order_line is
  'One item of a sales order — reference field set VBAP. The price is the result of the condition record that stood for the order date, and the record is named here so the document can be read back after the record moves. Reference: CAIRN.md §11.2 rows 3 and 8.';
comment on column public.sales_order_line.base_quantity is
  'The order quantity expressed in the material base unit, converted with the rate that stood when the order was written. It is what a later goods issue reduces stock by, so the order keeps it rather than converting again.';
comment on column public.sales_order_line.condition_number is
  'The condition record the price was read from. Not null because no other source of a price stands: a figure typed into a form is not a price, and the record an order read has to be readable from the order years later.';

-- The price master. A change closes the previous span and inserts a newer record, so an order priced
-- last month still reads the price that stood then. The empty customer or material position is the
-- general record, which is why those positions default to the empty string rather than to null: null
-- in a unique key would let two "any customer" rows stand side by side.
create table if not exists public.sales_condition_record (
  client varchar(4) not null,
  condition_number varchar(18) not null,
  condition_type varchar(4) not null default 'PR00',
  sales_org varchar(4) not null,
  distribution_channel varchar(2) not null,
  division varchar(2) not null,
  customer_number varchar(40) not null default '',
  material_number varchar(40) not null default '',
  currency char(3) not null,
  amount numeric(23, 4) not null,
  price_unit integer not null default 1,
  validity_from date not null,
  validity_to date not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, condition_number),
  constraint sales_condition_record_type_ck check (condition_type = 'PR00'),
  constraint sales_condition_record_amount_ck check (amount >= 0 and price_unit > 0),
  constraint sales_condition_record_validity_ck check (validity_to >= validity_from),
  constraint sales_condition_record_key_ck check (customer_number <> '' or material_number <> ''),
  constraint sales_condition_record_currency_fk
    foreign key (currency) references public.currency (code) on delete cascade,
  constraint sales_condition_record_area_fk
    foreign key (client, sales_org, distribution_channel, division)
    references public.sales_area (client, sales_org, distribution_channel, division) on delete cascade
);

-- The key a record is read by, and the reason a second "same price, same period" insert refuses: one
-- combination of sales area, customer, material and start date prices once.
create unique index if not exists sales_condition_record_key_uq
  on public.sales_condition_record (
    client, condition_type, sales_org, distribution_channel, division, customer_number, material_number, validity_from
  );
create index if not exists sales_condition_record_read_idx
  on public.sales_condition_record (client, condition_type, sales_org, distribution_channel, division, validity_to);

-- Stated after both tables stand, because the order line is created first and the reference runs the
-- other way: an item keeps the record it priced from, so that record cannot be deleted.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'sales_order_line_condition_fk' and connamespace = 'public'::regnamespace
  ) then
    alter table public.sales_order_line
      add constraint sales_order_line_condition_fk
      foreign key (client, condition_number)
      references public.sales_condition_record (client, condition_number) on delete cascade;
  end if;
end $$;

comment on table public.sales_condition_record is
  'Sales condition record: the price one combination of sales area, customer and material carries for a period. A customer-independent or material-independent record uses the empty key, the narrowest standing record wins, and a change closes the previous span rather than overwriting it. Maintained at /sales/conditions under CFG.SALES.CONDITION.MAINTAIN. Reference: CAIRN.md §11.2 row 3.';
comment on column public.sales_condition_record.customer_number is
  'The customer the price is stated for. The empty string is the customer-independent record; a customer number that is not a business partner is refused by the service rather than treated as a wildcard.';
comment on column public.sales_condition_record.price_unit is
  'How many units the amount is stated for: 100 means the price is per hundred. It is stored with the amount because a quotation that says 25 per 100 is not 25 each.';

-- Rights, stated per table as the grant policy requires (docs/migration-authoring.md). The order and
-- its items are documents their own service updates. A condition record is closed and replaced, never
-- deleted, so its UPDATE is stated and its DELETE is refused.
grant select, insert, update, delete on table public.sales_order to cairn_app;
grant select, insert, update, delete on table public.sales_order_line to cairn_app;
-- A condition record is a mutable master: a maintainer changes the price that stands today, and the
-- service closes the span the previous record covered rather than overwriting it in place. Deletion is
-- kept by a foreign key from the order item that read it, so the record an order priced from cannot be
-- dropped while the order stands.
grant select, insert, update, delete on table public.sales_condition_record to cairn_app;

revoke all on table public.sales_order from public;
revoke all on table public.sales_order_line from public;
revoke all on table public.sales_condition_record from public;

-- All three are tenant-scoped, so each carries the forced policy that the platform's withTenant sets
-- are judged by (D-041). A table without it would read across clients.
do $$
declare
  target text;
begin
  foreach target in array array['sales_order', 'sales_order_line', 'sales_condition_record']
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);
    execute format(
      'create policy tenant_isolation on public.%I using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      target
    );
  end loop;
end $$;

-- What the sales codes now reach. They were registered before the chain existed, so the description
-- has to name the screen the code unlocks (R-02, D-034).
update capability
   set description = 'Create, change and cancel a sales order at /sales/orders. The item price is read from the standing condition record, the save runs the credit check for the order value, and the order posts no accounting document.'
 where code = 'SALES.ORDER.CREATE';
update capability
   set description = 'Release a sales order the credit check blocked, at /finance/credit-release. An order whose standing determination is BLOCKED keeps that state until a release is recorded against it.'
 where code = 'SALES.ORDER.RELEASE';
-- CFG.SALES.CONDITION.MAINTAIN is the code the configuration catalog has always named for condition-record
-- maintenance, the screen gates on it, and the registry row below points at it -- but no capability row declared
-- it. A code with no row can never be granted to a role, so the screen would be unreachable for every user.
-- It is registered here in the form migrations 9105 to 9150 use, with the durability rule the record carries.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.CONDITION.MAINTAIN', 'SALES', 'CONFIGURE', false,
  'Maintain sales condition records at /sales/conditions: the price one customer and material carries for a period. A change closes the previous validity span and inserts a new record. A record a sales order line prices from cannot be deleted.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'SALES.ORDER.CREATE',
  'sales_order',
  'Sales order',
  'TRANSACTION',
  'SD',
  $so9$Sales order entry and change: the header, its items, and the price each item is read from. VA01, VA02 and VA03 are search aliases of this one screen; the order reserves nothing and posts nothing. Credit blocking and its release are at /finance/credit-release, the prices are maintained at /sales/conditions, and the outbound delivery, goods issue and billing are the next link of the chain.$so9$,
  'TIER_1_LIVE',
  '/sales/orders',
  'B',
  'MIGRATION_9190'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9190',
  changed_at = now();

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'CFG.SALES.CONDITION.MAINTAIN',
  'sales_condition_record',
  'Sales condition records',
  'TRANSACTION',
  'SD',
  $sc9$The price a customer is charged for a material in a sales area, valid for a period. VK11, VK12 and VK13 are search aliases of this screen. A saved change closes the record that stood and inserts the new span, so an order priced earlier still reads the price it was priced at. Sales orders take their prices only from these records.$sc9$,
  'TIER_1_LIVE',
  '/sales/conditions',
  'B',
  'MIGRATION_9190'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9190',
  changed_at = now();
