-- 9333_dunning_document_currency.sql
--
-- A dunning notice states what a customer owes, and a receivable is owed in the document
-- currency of the item. The dunning service previously read the item's *local* carrying amount
-- and labelled it with the *document* currency code, so a foreign-currency notice quoted a
-- KWD amount under a USD label. The item amount is now the document remaining amount.
--
-- Because one notice speaks one currency, an account with overdue items in more than one
-- currency is no longer excluded wholesale: it is proposed once per currency, each row carrying
-- its own total and its own currency. That puts the currency into the account key, the item's
-- foreign key and the notice's identity.
--
-- No existing notice row is rewritten. Every existing account row was proposed in a single
-- currency, so it already satisfies the stricter key; rows proposed with a NULL currency are
-- backfilled from the company's local currency, the only currency such a row could have been.

-- ── Account: one row per (customer, currency), currency always stated ─────────────────────────
update public.dunning_run_account a
   set currency = c.currency
  from public.company_code c
 where a.currency is null
   and c.client = a.client
   and c.company_code = a.company_code;

alter table public.dunning_run_account
  alter column currency set not null;

-- The item's own key and foreign key build on the account key, so they are dropped before the
-- account key is replaced and restored against the new key afterwards.
alter table public.dunning_run_item
  drop constraint if exists dunning_run_item_account_fk;

alter table public.dunning_run_account
  drop constraint if exists dunning_run_account_pkey;
alter table public.dunning_run_account
  add constraint dunning_run_account_pkey
  primary key (client, run_date, run_id, company_code, customer, currency);

-- ── Item: belongs to the account row of its own currency ─────────────────────────────────────
alter table public.dunning_run_item
  add constraint dunning_run_item_account_fk
  foreign key (client, run_date, run_id, company_code, customer, currency)
  references public.dunning_run_account (client, run_date, run_id, company_code, customer, currency)
  on delete cascade;

-- ── Notice: one per (customer, currency) ─────────────────────────────────────────────────────
drop index if exists public.dunning_notice_run_account_uq;
create unique index if not exists dunning_notice_run_account_uq
  on public.dunning_notice (client, run_date, run_id, company_code, customer, currency);

comment on column public.dunning_run_account.currency is
  'The currency this account total speaks. One account row per (customer, currency); a notice states one currency.';
