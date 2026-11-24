-- credit-currency-impact.sql
--
-- READ-ONLY. Changes nothing; meant to be run by a person before the credit-currency repair is relied on.
--
-- What it answers:
--   PART A — open sales documents whose credit determination changes under the repaired logic, in both
--            directions (a document that passed and now blocks, and one that blocked and now passes).
--   PART B — open foreign-currency documents that would be refused right now because no AVERAGE rate is
--            maintained from their currency to their credit control area's currency, on or before their own
--            document date.
--
-- The old behaviour compared the document-currency value directly with the area-currency limit. The new
-- behaviour translates at the AVERAGE rate in force on the document's date. Both are recomputed here from
-- the same inputs so the two verdicts can be compared row by row.
--
-- The exposure basis is unchanged by the repair (foreign commitments remain excluded), so only the judged
-- amount moves. A document whose currency already equals its area's currency cannot change: it is skipped.
--
-- Usage (cross-tenant read of credit_determination needs the migration role):
--   psql "$MIGRATION_DATABASE_URL" -v client='<client>' -f scripts/credit-currency-impact.sql
-- Omit -v client to cover every tenant.

\if :{?client}
\else
  \set client ''
\endif

\echo '=== PART A: open documents whose determination would change ==='

with latest as (
  select d.client, d.sales_document, d.customer, d.document_date, d.credit_control_area,
         d.order_value, d.order_currency, d.status, d.reason,
         row_number() over (
           partition by d.client, d.sales_document
           order by d.document_date desc, d.created_by, d.determination_id
         ) as rn
    from credit_determination d
   where (:'client' = '' or d.client = :'client')
),
current as (
  select * from latest where rn = 1
),
judged as (
  select c.client, c.sales_document, c.customer, c.document_date, c.credit_control_area,
         c.order_value, c.order_currency, c.status as old_status,
         cca.currency as area_currency,
         cr.credit_limit as limit_amount,
         -- The rate in force on the document's own date, newest first.
         (select r.rate * r.ratio_to / r.ratio_from
            from exchange_rate r
           where r.client = c.client and r.rate_type = 'AVERAGE'
             and r.from_currency = c.order_currency and r.to_currency = cca.currency
             and r.valid_from <= c.document_date
           order by r.valid_from desc limit 1) as direct_rate,
         (select 1 / (r.rate * r.ratio_to / r.ratio_from)
            from exchange_rate r
           where r.client = c.client and r.rate_type = 'AVERAGE'
             and r.from_currency = cca.currency and r.to_currency = c.order_currency
             and r.valid_from <= c.document_date
           order by r.valid_from desc limit 1) as inverse_rate
    from current c
    join credit_control_area cca
      on cca.client = c.client and cca.credit_control_area = c.credit_control_area
    left join customer_credit cr
      on cr.client = c.client and cr.customer = c.customer
     and cr.credit_control_area = c.credit_control_area
   where c.order_currency <> cca.currency
     and c.credit_control_area is not null
     -- Only documents still relevant: the determination is the standing one and the document is open.
     and (
       exists (select 1 from sales_order o
                where o.client = c.client and o.order_number = c.sales_document and o.status = 'OPEN')
       or exists (select 1 from delivery dl
                where dl.client = c.client and dl.delivery_number = c.sales_document
                  and dl.status not in ('CANCELLED', 'GOODS_ISSUED'))
     )
),
resolved as (
  select j.*, coalesce(j.direct_rate, j.inverse_rate) as rate
    from judged j
)
select
  r.client,
  r.customer,
  r.sales_document,
  r.document_date,
  r.order_currency,
  r.area_currency,
  r.order_value::text                    as document_amount,
  r.rate::text                           as rate_used,
  round(r.order_value * r.rate, 4)::text as amount_in_area_currency,
  r.limit_amount::text                   as credit_limit,
  r.old_status,
  -- New verdict on the translated figure. A missing rate is its own outcome, never a comparison.
  case
    when r.rate is null then 'REFUSED_NO_RATE'
    when r.limit_amount is null then 'BLOCK_NO_CREDIT_RECORD'
    when round(r.order_value * r.rate, 4) > r.limit_amount then 'BLOCK_LIMIT_EXCEEDED'
    else 'PASS'
  end                                    as new_verdict,
  case
    when r.rate is null then 'NO_RATE'
    when r.old_status = 'PASSED'
      and r.limit_amount is not null
      and round(r.order_value * r.rate, 4) > r.limit_amount then 'PASSED -> BLOCKED'
    when r.old_status = 'BLOCKED'
      and r.limit_amount is not null
      and round(r.order_value * r.rate, 4) <= r.limit_amount then 'BLOCKED -> PASSED'
    else 'unchanged'
  end                                    as direction
from resolved r
where r.rate is not null
  and r.limit_amount is not null
  and (
    (r.old_status = 'PASSED' and round(r.order_value * r.rate, 4) > r.limit_amount)
    or (r.old_status = 'BLOCKED' and round(r.order_value * r.rate, 4) <= r.limit_amount)
  )
order by r.client, r.customer, r.document_date, r.sales_document;

\echo '=== PART A counts ==='

with latest as (
  select d.client, d.sales_document, d.customer, d.document_date, d.credit_control_area,
         d.order_value, d.order_currency, d.status,
         row_number() over (
           partition by d.client, d.sales_document
           order by d.document_date desc, d.created_by, d.determination_id
         ) as rn
    from credit_determination d
   where (:'client' = '' or d.client = :'client')
),
current as (select * from latest where rn = 1),
judged as (
  select c.client, c.sales_document, c.status as old_status,
         cca.currency as area_currency, cr.credit_limit as limit_amount,
         c.order_value, c.document_date, c.order_currency,
         coalesce(
           (select r.rate * r.ratio_to / r.ratio_from from exchange_rate r
             where r.client = c.client and r.rate_type = 'AVERAGE'
               and r.from_currency = c.order_currency and r.to_currency = cca.currency
               and r.valid_from <= c.document_date
             order by r.valid_from desc limit 1),
           (select 1 / (r.rate * r.ratio_to / r.ratio_from) from exchange_rate r
             where r.client = c.client and r.rate_type = 'AVERAGE'
               and r.from_currency = cca.currency and r.to_currency = c.order_currency
               and r.valid_from <= c.document_date
             order by r.valid_from desc limit 1)
         ) as rate
    from current c
    join credit_control_area cca
      on cca.client = c.client and cca.credit_control_area = c.credit_control_area
    left join customer_credit cr
      on cr.client = c.client and cr.customer = c.customer
     and cr.credit_control_area = c.credit_control_area
   where c.order_currency <> cca.currency and c.credit_control_area is not null
)
select
  case
    when rate is null then 'would be refused (no rate)'
    when limit_amount is null then 'blocked (no record)'
    when old_status = 'PASSED' and round(order_value * rate, 4) > limit_amount then 'PASSED -> BLOCKED'
    when old_status = 'BLOCKED' and round(order_value * rate, 4) <= limit_amount then 'BLOCKED -> PASSED'
    else 'unchanged'
  end as outcome,
  count(*) as documents
from judged
group by 1
order by 1;

\echo '=== PART B: open foreign-currency documents that would be refused (no rate maintained) ==='

with latest as (
  select d.client, d.sales_document, d.customer, d.document_date, d.credit_control_area,
         d.order_value, d.order_currency, d.status,
         row_number() over (
           partition by d.client, d.sales_document
           order by d.document_date desc, d.created_by, d.determination_id
         ) as rn
    from credit_determination d
   where (:'client' = '' or d.client = :'client')
),
current as (select * from latest where rn = 1)
select
  c.client,
  c.customer,
  c.sales_document,
  c.document_date,
  c.order_currency,
  cca.currency                       as area_currency,
  c.order_value::text                as document_amount,
  c.status                           as old_status,
  'No AVERAGE rate stands from ' || c.order_currency || ' to ' || cca.currency
    || ' on or before ' || c.document_date as refusal
from current c
join credit_control_area cca
  on cca.client = c.client and cca.credit_control_area = c.credit_control_area
where c.order_currency <> cca.currency
  and c.credit_control_area is not null
  -- No direct and no inverse AVERAGE row on or before the document date.
  and not exists (
    select 1 from exchange_rate r
     where r.client = c.client and r.rate_type = 'AVERAGE'
       and r.from_currency = c.order_currency and r.to_currency = cca.currency
       and r.valid_from <= c.document_date)
  and not exists (
    select 1 from exchange_rate r
     where r.client = c.client and r.rate_type = 'AVERAGE'
       and r.from_currency = cca.currency and r.to_currency = c.order_currency
       and r.valid_from <= c.document_date)
order by c.client, c.customer, c.document_date, c.sales_document;
