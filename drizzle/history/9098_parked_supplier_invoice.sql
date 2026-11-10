-- SCR-160 — a parked supplier invoice is not a posted invoice.
--
-- The row is the park. There is no status to complete, post, delete or reject.
-- Posting remains supplier_invoice, and only a posted row counts as invoiced.
-- The purchase order is named and is not consumed. The goods receipt is not
-- consumed. No journal is written. The supplier, the company and the currency
-- are the order's and are stored so the document can be read after the park.
-- The tax is calculated, not entered. A category other than the invoice is not
-- a column this round writes. The number is PARKINV, not the vendor invoice
-- range and not the parked journal range.
--
-- The name carries no transaction alias.

create table if not exists public.parked_supplier_invoice (
  client varchar(4) not null references public.client (client) on delete cascade,
  parked_number varchar(20) not null,
  fiscal_year integer not null,
  supplier_number varchar(40) not null,
  company_code varchar(10) not null,
  purchase_order_number varchar(20) not null,
  invoice_date date not null,
  posting_date date not null,
  supplier_reference varchar(16) not null,
  currency char(3) not null,
  gross_amount numeric(23, 4) not null,
  tax_amount numeric(23, 4) not null default 0,
  payment_terms varchar(12),
  baseline_date date,
  due_date date,
  header_text varchar(100),
  request_key varchar(64) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint parked_supplier_invoice_pk primary key (client, parked_number),
  constraint parked_supplier_invoice_order_pair_uq unique (client, parked_number, purchase_order_number),
  constraint parked_supplier_invoice_request_uq unique (client, request_key),
  constraint parked_supplier_invoice_reference_uq unique (client, company_code, supplier_number, supplier_reference),
  constraint parked_supplier_invoice_order_fk
    foreign key (client, purchase_order_number)
    references public.purchase_order (client, order_number)
    on delete restrict,
  constraint parked_supplier_invoice_number_ck check (char_length(btrim(parked_number)) between 1 and 20),
  constraint parked_supplier_invoice_year_ck check (fiscal_year between 1000 and 9999),
  constraint parked_supplier_invoice_reference_ck check (char_length(btrim(supplier_reference)) between 1 and 16),
  constraint parked_supplier_invoice_amounts_ck check (gross_amount >= 0 and tax_amount >= 0),
  constraint parked_supplier_invoice_text_ck check (
    header_text is null or char_length(btrim(header_text)) between 1 and 100
  )
);

create index if not exists parked_supplier_invoice_order_idx
  on public.parked_supplier_invoice (client, purchase_order_number);

create table if not exists public.parked_supplier_invoice_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  parked_number varchar(20) not null,
  purchase_order_number varchar(20) not null,
  line_number integer not null,
  purchase_order_item integer not null,
  material_number varchar(40),
  plant varchar(10),
  quantity numeric(23, 3) not null,
  unit varchar(10) not null,
  net_amount numeric(23, 4) not null,
  expected_amount numeric(23, 4) not null,
  variance_amount numeric(23, 4) not null default 0,
  tax_code varchar(4),
  tax_amount numeric(23, 4) not null default 0,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint parked_supplier_invoice_item_pk primary key (client, parked_number, line_number),
  constraint parked_supplier_invoice_item_header_fk
    foreign key (client, parked_number, purchase_order_number)
    references public.parked_supplier_invoice (client, parked_number, purchase_order_number)
    on delete restrict,
  constraint parked_supplier_invoice_item_order_item_fk
    foreign key (client, purchase_order_number, purchase_order_item)
    references public.purchase_order_item (client, order_number, item_number)
    on delete restrict,
  constraint parked_supplier_invoice_item_line_ck check (line_number = purchase_order_item),
  constraint parked_supplier_invoice_item_qty_ck check (quantity > 0),
  constraint parked_supplier_invoice_item_amounts_ck check (
    net_amount >= 0 and expected_amount >= 0 and tax_amount >= 0
  )
);

alter table public.parked_supplier_invoice enable row level security;
alter table public.parked_supplier_invoice force row level security;
create policy tenant_isolation on public.parked_supplier_invoice
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.parked_supplier_invoice from public;
grant select, insert, update, delete on public.parked_supplier_invoice to cairn_app;

alter table public.parked_supplier_invoice_item enable row level security;
alter table public.parked_supplier_invoice_item force row level security;
create policy tenant_isolation on public.parked_supplier_invoice_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.parked_supplier_invoice_item from public;
grant select, insert, update, delete on public.parked_supplier_invoice_item to cairn_app;

insert into public.number_range_object
  (client, object_code, description, number_length, year_relevant, subobject_hint, created_by)
select c.client, 'PARKINV', 'Parked supplier invoices', 7, false, null, 'SYSTEM'
  from public.client c
on conflict do nothing;

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'PARKINV', '*', '*', 0, 'PV', 1, 999999, 0, 7, 'READABLE', 'SYSTEM'
  from public.client c
on conflict do nothing;
