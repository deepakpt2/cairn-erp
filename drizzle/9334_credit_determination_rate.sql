-- 9334_credit_determination_rate.sql
--
-- A credit determination now records the exchange rate it judged at, and the date that rate took effect.
--
-- The judged amount is a document-currency figure translated into the credit control area's currency. Two
-- documents for the same customer, judged on different days, can therefore reach different verdicts on the
-- same figure; and a rate that has gone stale silently changes what "within the limit" means. Without the
-- rate, a determination cannot be re-read or audited: a person looking at a blocked order could not say
-- which rate blocked it, and re-judging it after a rate change would look like the engine changing its mind.
--
-- Both columns are nullable because a determination judged in the area's own currency uses no rate (it is
-- the identity), and because every row written before this migration has none. Nothing is backfilled: the
-- rate such a row used was never recorded and must not be invented.
--
-- The rate is stored at the ledger's own 8 decimals (the effective rate, rate × ratioTo / ratioFrom), so it
-- reproduces the figure exactly rather than approximately.

alter table public.credit_determination
  add column if not exists rate_used numeric(18,8),
  add column if not exists rate_date date;

comment on column public.credit_determination.rate_used is
  'Effective exchange rate applied to translate order_value into the credit control area currency. Null when judged in that currency.';
comment on column public.credit_determination.rate_date is
  'The valid_from of the rate row used. Null when no rate was needed or none was recorded.';
