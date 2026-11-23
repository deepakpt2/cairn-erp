-- Close the FX reconciliation and settlement blockers.
--
-- 1. Journal provenance for period-end FX valuation postings and their reversals, so the bank
--    reconciliation can prove a local-only carrying adjustment instead of guessing from text.
-- 2. The actual bank-account-currency movement supplied for a cross-currency payment, kept apart
--    from the master-rate accounting amount.
-- 3. The complete actual-bank-amount evidence for a payment-run execution.

alter table journal_entry
  add column if not exists is_fx_valuation boolean not null default false;

alter table incoming_payment
  add column if not exists bank_amount numeric(23, 4) not null default 0,
  add column if not exists bank_currency char(3),
  add column if not exists bank_amount_source varchar(24) not null default 'NOT_RECORDED';

alter table outgoing_payment
  add column if not exists bank_amount numeric(23, 4) not null default 0,
  add column if not exists bank_currency char(3),
  add column if not exists bank_amount_source varchar(24) not null default 'NOT_RECORDED';

alter table payment_document
  add column if not exists bank_amount numeric(23, 4) not null default 0,
  add column if not exists bank_currency char(3),
  add column if not exists bank_amount_source varchar(24) not null default 'NOT_RECORDED';

alter table payment_run_operation
  add column if not exists bank_amounts jsonb;
