-- SCR-096 / R-144 (stage 2): FB50 line assignment, canonical line
-- constraints, and the direct-posting request registry.
--
-- The parked journal line has always retained an assignment; the
-- canonical journal line gains the same column so a posted FB50
-- document keeps what the user entered. Line direction and
-- positivity, today engine-enforced, also stand as database
-- constraints. The request registry is idempotency bookkeeping
-- only — it names the document a submission produced so a repeat
-- returns it instead of posting twice. It is not a document table.
alter table public.journal_entry_line
  add column assignment varchar(18);
--> statement-breakpoint
alter table public.journal_entry_line
  add constraint journal_entry_line_dc_ck check (debit_credit in ('S', 'H'));
--> statement-breakpoint
alter table public.journal_entry_line
  add constraint journal_entry_line_amount_ck check (amount_document > 0 and amount_local > 0);
--> statement-breakpoint
create table public.journal_posting_request (
  client varchar(4) not null references public.client(client) on delete cascade,
  request_key varchar(64) not null,
  actor varchar(60) not null,
  document_number varchar(40) not null,
  fiscal_year integer not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, request_key)
);
