-- SCR-076 / R-124 (stage 2): vendor credit memo.
--
-- A credit memo is a vendor-invoice document of its own category:
-- the header gains the category (invoice or credit memo) and the
-- optional link to the original invoice it stands against. No new
-- table; the KG journal is the authoritative posting.
alter table public.vendor_invoice
  add column category varchar(12) not null default 'INVOICE';
--> statement-breakpoint
alter table public.vendor_invoice
  add column credit_of varchar(20);
--> statement-breakpoint
alter table public.vendor_invoice
  add constraint vendor_invoice_category_ck check (category in ('INVOICE', 'CREDIT_MEMO'));
