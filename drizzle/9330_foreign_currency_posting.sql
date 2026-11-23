-- 9330_foreign_currency_posting.sql
--
-- Foreign-currency posting: a document snapshots the exchange rate it was translated at, and a
-- realized exchange difference has a place to stand without inventing a document-currency amount.
--
-- journal_entry gains the provenance of its stored rate (which master row, how quoted). Nothing is
-- backfilled: a historical document with no provenance is exactly that, and the audit script names it.
--
-- journal_entry_line gains is_local_only. A realized FX line has a local amount and no document
-- amount; the old check (amount_document > 0) made that unrepresentable, so the check is widened for
-- these lines only. Every other line still requires a positive document amount.
--
-- Invoice, billing and payment records snapshot the effective rate and the local carrying amount so
-- a screen and an auditor read the same figure without reconstructing it.

alter table public.journal_entry
  add column if not exists rate_type varchar(12),
  add column if not exists rate_source varchar(24),
  add column if not exists rate_valid_from date,
  add column if not exists rate_raw numeric(18,8),
  add column if not exists rate_ratio_from integer,
  add column if not exists rate_ratio_to integer,
  add column if not exists rate_is_indirect_quote boolean not null default false;

alter table public.journal_entry_line
  add column if not exists is_local_only boolean not null default false;

alter table public.journal_entry_line drop constraint if exists journal_entry_line_amount_ck;
alter table public.journal_entry_line
  add constraint journal_entry_line_amount_ck
  check ((amount_document > 0 or is_local_only) and amount_local > 0);

alter table public.customer_invoice
  add column if not exists exchange_rate numeric(18,8) not null default 1,
  add column if not exists local_gross_amount numeric(23,4) not null default 0;

alter table public.vendor_invoice
  add column if not exists exchange_rate numeric(18,8) not null default 1,
  add column if not exists local_gross_amount numeric(23,4) not null default 0;

alter table public.supplier_invoice
  add column if not exists exchange_rate numeric(18,8) not null default 1,
  add column if not exists local_gross_amount numeric(23,4) not null default 0;

alter table public.billing_document
  add column if not exists exchange_rate numeric(18,8) not null default 1,
  add column if not exists local_gross_value numeric(23,4) not null default 0;

alter table public.incoming_payment
  add column if not exists exchange_rate numeric(18,8) not null default 1,
  add column if not exists local_amount numeric(23,4) not null default 0;

alter table public.outgoing_payment
  add column if not exists exchange_rate numeric(18,8) not null default 1,
  add column if not exists local_amount numeric(23,4) not null default 0;

-- The reconciliation records the account-currency allocation and, separately, the local carrying
-- amount it relieves, so a foreign bank account can be reconciled without converting at today's rate.
alter table public.bank_reconciliation_match
  add column if not exists allocated_local_amount numeric(23,4) not null default 0;
