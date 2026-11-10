-- SCR-162 — a manual payment hold on a posted supplier invoice.
--
-- The hold is not a second payable and not a journal. The open item remains
-- the supplier line of the invoice journal. The payment run reads an active
-- hold and leaves that line out. A release clears the hold and appends an
-- event. It does not post, clear, or change the invoice amount.
--
-- A price block and a quantity block are not rows. Invoice verification does
-- not block a payment, and no tolerance stands to judge one. The name carries
-- no transaction alias.

create table if not exists public.supplier_invoice_payment_block (
  client varchar(4) not null references public.client (client) on delete cascade,
  invoice_number varchar(20) not null,
  reason varchar(16) not null,
  journal_document_number varchar(40) not null,
  active boolean not null,
  comment varchar(100) not null,
  version integer not null default 1,
  cleared_by varchar(60),
  cleared_at timestamptz,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint supplier_invoice_payment_block_pk primary key (client, invoice_number, reason),
  constraint supplier_invoice_payment_block_invoice_fk
    foreign key (client, invoice_number)
    references public.supplier_invoice (client, invoice_number)
    on delete restrict,
  constraint supplier_invoice_payment_block_reason_ck check (reason = 'MANUAL'),
  constraint supplier_invoice_payment_block_version_ck check (version > 0),
  constraint supplier_invoice_payment_block_comment_ck check (char_length(btrim(comment)) between 1 and 100),
  constraint supplier_invoice_payment_block_active_ck check (
    (active and cleared_at is null and cleared_by is null)
    or (not active and cleared_at is not null and cleared_by is not null)
  )
);

create index if not exists supplier_invoice_payment_block_active_idx
  on public.supplier_invoice_payment_block (client, active, invoice_number);

create table if not exists public.supplier_invoice_payment_block_event (
  client varchar(4) not null references public.client (client) on delete cascade,
  event_id bigint generated always as identity,
  invoice_number varchar(20) not null,
  reason varchar(16) not null,
  action varchar(16) not null,
  outcome varchar(16) not null,
  actor varchar(60) not null,
  comment varchar(100) not null,
  request_key varchar(64) not null,
  previous_active boolean not null,
  resulting_active boolean not null,
  created_at timestamptz not null default now(),
  constraint supplier_invoice_payment_block_event_pk primary key (client, event_id),
  constraint supplier_invoice_payment_block_event_block_fk
    foreign key (client, invoice_number, reason)
    references public.supplier_invoice_payment_block (client, invoice_number, reason)
    on delete restrict,
  constraint supplier_invoice_payment_block_event_request_uq unique (client, request_key),
  constraint supplier_invoice_payment_block_event_action_ck check (action in ('PLACE', 'RELEASE', 'REBLOCK')),
  constraint supplier_invoice_payment_block_event_outcome_ck check (outcome in ('HELD', 'RELEASED')),
  constraint supplier_invoice_payment_block_event_comment_ck check (char_length(btrim(comment)) between 1 and 100)
);

alter table public.supplier_invoice_payment_block enable row level security;
alter table public.supplier_invoice_payment_block force row level security;
create policy tenant_isolation on public.supplier_invoice_payment_block
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.supplier_invoice_payment_block from public;
grant select, insert, update on public.supplier_invoice_payment_block to cairn_app;

alter table public.supplier_invoice_payment_block_event enable row level security;
alter table public.supplier_invoice_payment_block_event force row level security;
create policy tenant_isolation on public.supplier_invoice_payment_block_event
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.supplier_invoice_payment_block_event from public;
grant select, insert on public.supplier_invoice_payment_block_event to cairn_app;
