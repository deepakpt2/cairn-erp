-- dunning-notice-currency-mismatch.sql
--
-- READ-ONLY report. It changes nothing, and it is meant to be run by a person, not by a service.
--
-- Why it exists: until migration 9333 the dunning service read each item's LOCAL carrying amount
-- (`journal_entry_line.amount_local`) and stored it under the item's DOCUMENT currency code
-- (`journal_entry_line.currency`). On a company whose local currency differs from the item
-- currency, a notice therefore quoted a local amount under a foreign label — a USD 1,200 invoice
-- on a KWD company showed "360.0000 USD" instead of "1200.0000 USD".
--
-- How a mislabelled row is recognised. Dating the row is the only sound test: after 9333 a notice
-- in a foreign currency is *correct*, because it now states the document-currency amount. So the
-- report lists notices written BEFORE 9333 was applied whose stored currency is not the company's
-- local currency. Those are the rows the old code produced. A notice written after 9333 is never
-- listed, however foreign its currency.
--
-- The report is informational. No notice row is rewritten by this task and none should be edited
-- by hand; a re-run produces correct notices. Existing rows are listed so the scale of the old
-- mislabelling is visible.
--
-- Run with the migration role (it reads cairn_migration, which the runtime role does not see):
--   psql "$MIGRATION_DATABASE_URL" -v client='<client>' \
--        -f scripts/dunning-notice-currency-mismatch.sql
-- Omit -v client to report every tenant.

\if :{?client}
\else
  \set client ''
\endif

with cutoff as (
  select applied_at
    from cairn_migration
   where filename = '9333_dunning_document_currency.sql'
)
select
  n.client,
  n.notice_number,
  n.run_date,
  n.run_id,
  n.company_code,
  n.customer,
  n.dunning_level,
  n.notice_date,
  n.created_at,
  n.currency                                        as stored_currency,
  c.currency                                        as company_local_currency,
  n.amount::text                                    as stored_amount,
  -- What the label promises: the same figure expressed in the document currency. The old amount
  -- was the local carrying amount, so this is the label's error, not a second computation of truth.
  coalesce((
    select sum(l.overdue_amount)::text
      from dunning_run_item l
     where l.client = n.client
       and l.run_date = n.run_date
       and l.run_id = n.run_id
       and l.company_code = n.company_code
       and l.customer = n.customer
       and l.currency = n.currency
  ), '0')                                           as item_amount_as_stored
from dunning_notice n
join company_code c
  on c.client = n.client
 and c.company_code = n.company_code
cross join cutoff
where (:'client' = '' or n.client = :'client')
  -- Written by the old code: before the repair, and not in the company's local currency.
  and n.created_at < cutoff.applied_at
  and n.currency <> c.currency
order by n.client, n.run_date, n.run_id, n.customer, n.currency;
