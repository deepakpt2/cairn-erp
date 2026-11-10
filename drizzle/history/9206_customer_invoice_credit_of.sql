-- DI-020: customer credit memo.
--
-- A customer credit memo is a customer-invoice document of its own category:
-- the header gains an optional link to the original billing document it stands
-- against. No new table; the DR journal is the authoritative posting.
alter table public.customer_invoice
  add column credit_of varchar(20);
--> statement-breakpoint
alter table public.billing_document
  add column credit_of varchar(20);
