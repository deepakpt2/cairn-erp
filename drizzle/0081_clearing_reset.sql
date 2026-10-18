-- SCR-071 / R-119 (stage 2): clearing reset records.
--
-- A reset lifts the clearing stamp from the lines a clearing
-- document cleared; the stamps alone would erase the evidence, so
-- every reset stands on this record — the clearing document, the
-- former clearing date, the items reopened and the mandatory
-- reason — written in the same transaction as the stamp clearing.
-- A reset record is never edited or deleted.
create table public.clearing_reset (
  client varchar(4) not null references public.client(client) on delete cascade,
  reset_number varchar(20) not null,
  company_code varchar(10) not null,
  clearing_document varchar(40) not null,
  fiscal_year integer not null,
  clearing_date date not null,
  items_reset integer not null,
  item_refs text not null,
  reason varchar(500) not null,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, reset_number),
  constraint clearing_reset_items_ck check (items_reset > 0),
  constraint clearing_reset_reason_ck check (length(reason) > 0)
);
--> statement-breakpoint
create unique index clearing_reset_request_key_uq
  on public.clearing_reset (client, request_key) where request_key is not null;
--> statement-breakpoint
create index clearing_reset_document_idx
  on public.clearing_reset (client, company_code, clearing_document, fiscal_year);
