-- SCR-163 — a GR/IR maintenance posting.
--
-- The residual is the posted GR/IR difference on one purchase-order item.
-- This link names the journal that cleared it. It is not a second ledger,
-- and it is not a material document. A reversal marks the link. It does
-- not delete the journal.

create table if not exists public.gr_ir_maintenance_link (
  client varchar(4) not null references public.client (client) on delete cascade,
  document_number varchar(40) not null,
  fiscal_year integer not null,
  order_number varchar(20) not null,
  item_number integer not null,
  company_code varchar(10) not null,
  posting_date date not null,
  key_date date not null,
  surplus varchar(16) not null,
  allocated_amount numeric(23, 4) not null,
  currency char(3) not null,
  allocated_quantity numeric(13, 3) not null,
  quantity_unit varchar(6) not null,
  gr_ir_account varchar(10) not null,
  offset_account varchar(10) not null,
  fingerprint varchar(80) not null,
  request_key varchar(64) not null,
  comment varchar(100) not null,
  reversed_by varchar(40),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint gr_ir_maintenance_link_pk primary key (client, document_number, fiscal_year),
  constraint gr_ir_maintenance_link_request_uq unique (client, request_key),
  constraint gr_ir_maintenance_link_item_fk
    foreign key (client, order_number, item_number)
    references public.purchase_order_item (client, order_number, item_number)
    on delete restrict,
  constraint gr_ir_maintenance_link_journal_fk
    foreign key (client, document_number, fiscal_year)
    references public.journal_entry (client, document_number, fiscal_year)
    on delete restrict,
  constraint gr_ir_maintenance_link_surplus_ck check (surplus in ('DELIVERY', 'INVOICE')),
  constraint gr_ir_maintenance_link_amount_ck check (allocated_amount <> 0),
  constraint gr_ir_maintenance_link_comment_ck check (char_length(btrim(comment)) between 1 and 100),
  constraint gr_ir_maintenance_link_unit_ck check (char_length(btrim(quantity_unit)) between 1 and 6)
);

create index if not exists gr_ir_maintenance_link_item_idx
  on public.gr_ir_maintenance_link (client, order_number, item_number);

alter table public.gr_ir_maintenance_link enable row level security;
alter table public.gr_ir_maintenance_link force row level security;
create policy tenant_isolation on public.gr_ir_maintenance_link
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.gr_ir_maintenance_link from public;
grant select, insert, update on public.gr_ir_maintenance_link to cairn_app;
