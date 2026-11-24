-- credit-currency-impact.sql
--
-- READ-ONLY. Creates only session-temporary views; changes no data. This is the go-live check to run
-- before credit blocks are relied on against real data.
--
-- What it answers:
--   PART A — open sales documents whose credit determination changes under option A (foreign commitments
--            converted into the basis) with the converted judged amount, in both directions: a document
--            that passed and now blocks, and one that blocked and now passes.
--   PART B — open foreign-currency documents that would be REFUSED right now, because no AVERAGE rate
--            stands for their currency pair on their document date, or the rate standing is older than
--            the tenant's maximum rate age (45 days by default).
--
-- Both recompute the verdict from the same inputs the service now uses:
--   exposure   = open receivables (amount_local) + every open commitment converted at its own document date
--   judged     = the document value converted at the document's own date
--   verdict    = block when (exposure excluding this document + judged) > limit
-- The old verdict is the standing determination's recorded status.
--
-- Expected on an empty or development database: NO ROWS in either part. A row in Part A is a document
-- whose verdict moves; a row in Part B is a document that will refuse until a rate is maintained.
-- Neither is an error — they are the work to do before go-live.
--
-- Usage (cross-tenant reads need the migration role):
--   psql "$MIGRATION_DATABASE_URL" -v client='<client>' -f scripts/credit-currency-impact.sql
-- Omit -v client to cover every tenant.

\if :{?client}
\else
  \set client ''
\endif

-- ── Shared inputs ──────────────────────────────────────────────────────────────────────────────

-- The standing (latest) determination per document.
drop view if exists imp_standing;
create temp view imp_standing as
  select d.*
    from (select cd.*,
                 row_number() over (partition by cd.client, cd.sales_document
                                    order by cd.created_at desc, cd.determination_id) as rn
            from credit_determination cd
           where (:'client' = '' or cd.client = :'client')) d
   where d.rn = 1;

-- The receivable half: already local, unchanged by the decision.
drop view if exists imp_ar;
create temp view imp_ar as
  select l.client, l.business_partner as customer, cm.credit_control_area as area,
         coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::numeric as amount
    from journal_entry_line l
    join journal_entry e
      on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
    join company_code cm
      on cm.client = e.client and cm.company_code = e.company_code and cm.credit_control_area is not null
   where (:'client' = '' or l.client = :'client')
     and l.business_partner is not null
     and e.status = 'POSTED' and l.clearing_document is null
   group by 1, 2, 3;

-- Every open commitment, per document currency and its own date (option A converts these).
drop view if exists imp_buckets;
create temp view imp_buckets as
  select o.client, o.customer_number as customer, o.currency as currency, o.order_date as document_date,
         o.order_number as order_number,
         (l.net_amount + l.tax_amount)
           * (l.order_quantity - coalesce(op.delivered, 0)) / l.order_quantity as value
    from sales_order_line l
    join sales_order o on o.client = l.client and o.order_number = l.order_number
    left join (
      select dl.client, dl.order_number, dl.order_line_number, sum(dl.delivery_quantity) as delivered
        from delivery_line dl
        join delivery d on d.client = dl.client and d.delivery_number = dl.delivery_number
         and d.status <> 'CANCELLED' and d.document_type <> 'CR'
       group by 1, 2, 3
    ) op on op.client = l.client and op.order_number = l.order_number and op.order_line_number = l.line_number
   where (:'client' = '' or l.client = :'client')
     and o.status = 'OPEN' and o.document_type <> 'CR'
     and l.status = 'OPEN' and l.order_quantity > coalesce(op.delivered, 0)
  union all
  select o.client, o.customer_number, o.currency, d.delivery_date,
         o.order_number as order_number,
         (l.net_amount + l.tax_amount) * dl.delivery_quantity / l.order_quantity
    from delivery_line dl
    join delivery d on d.client = dl.client and d.delivery_number = dl.delivery_number
    join sales_order o on o.client = d.client and o.order_number = d.order_number
    join sales_order_line l
      on l.client = dl.client and l.order_number = dl.order_number and l.line_number = dl.order_line_number
    left join billing_document bd
      on bd.client = dl.client and bd.delivery_number = dl.delivery_number and bd.status = 'POSTED'
   where (:'client' = '' or dl.client = :'client')
     and d.status <> 'CANCELLED' and d.document_type <> 'CR'
     and o.status <> 'CANCELLED' and bd.billing_number is null;

-- Each bucket converted at its own date, keeping the document it belongs to so the report can exclude
-- exactly the document being judged — the same thing `excludeSalesDocument` does in the service.
drop view if exists imp_bucket_converted;
create temp view imp_bucket_converted as
  select b.client, b.customer, cm.credit_control_area as area, b.order_number, b.currency,
         b.document_date, b.value,
         (case when b.currency = cca.currency then b.value
               else b.value * coalesce(
                 (select r.rate * r.ratio_to / r.ratio_from from exchange_rate r
                   where r.client = b.client and r.rate_type = 'AVERAGE'
                     and r.from_currency = b.currency and r.to_currency = cca.currency
                     and r.valid_from <= b.document_date order by r.valid_from desc limit 1),
                 (select 1 / (r.rate * r.ratio_to / r.ratio_from) from exchange_rate r
                   where r.client = b.client and r.rate_type = 'AVERAGE'
                     and r.from_currency = cca.currency and r.to_currency = b.currency
                     and r.valid_from <= b.document_date order by r.valid_from desc limit 1))
          end)::numeric as converted
    from imp_buckets b
    join company_code cm on cm.client = b.client and cm.credit_control_area is not null
    join credit_control_area cca on cca.client = cm.client and cca.credit_control_area = cm.credit_control_area;

-- The converted basis per customer and area (this document included).
drop view if exists imp_basis;
create temp view imp_basis as
  select s.client, s.customer, s.credit_control_area as area,
         coalesce((select a.amount from imp_ar a
                    where a.client = s.client and a.customer = s.customer
                      and a.area = s.credit_control_area), 0)
         + coalesce((select sum(bc.converted) from imp_bucket_converted bc
                      where bc.client = s.client and bc.customer = s.customer
                        and bc.area = s.credit_control_area), 0) as amount
    from (select distinct client, customer, credit_control_area from imp_standing
           where credit_control_area is not null) s;

-- Part A, scored exactly as the service scores it.
drop view if exists imp_part_a;
create temp view imp_part_a as
  select s.client, s.customer, s.sales_document, s.document_date, s.order_currency,
         cca.currency as area_currency, s.order_value, s.status as old_status,
         cr.credit_limit,
         coalesce(
           (select r.rate * r.ratio_to / r.ratio_from from exchange_rate r
             where r.client = s.client and r.rate_type = 'AVERAGE'
               and r.from_currency = s.order_currency and r.to_currency = cca.currency
               and r.valid_from <= s.document_date order by r.valid_from desc limit 1),
           case when s.order_currency = cca.currency then 1::numeric else
             (select 1 / (r.rate * r.ratio_to / r.ratio_from) from exchange_rate r
               where r.client = s.client and r.rate_type = 'AVERAGE'
                 and r.from_currency = cca.currency and r.to_currency = s.order_currency
                 and r.valid_from <= s.document_date order by r.valid_from desc limit 1)
           end) as rate,
         -- The basis with this document taken out; the service passes `excludeSalesDocument` and then
         -- adds the judged amount, so the two run through exactly the same arithmetic.
         coalesce(basis.amount, 0)
         - coalesce((
             select sum(x.converted) from imp_bucket_converted x
              where x.client = s.client and x.customer = s.customer
                and x.order_number = s.sales_document), 0) as basis_excluding_document
    from imp_standing s
    join credit_control_area cca
      on cca.client = s.client and cca.credit_control_area = s.credit_control_area
    left join customer_credit cr
      on cr.client = s.client and cr.customer = s.customer
     and cr.credit_control_area = s.credit_control_area
    left join imp_basis basis
      on basis.client = s.client and basis.customer = s.customer
     and basis.area = s.credit_control_area
   where s.credit_control_area is not null
     -- Only documents still relevant: the standing determination is for a document still open.
     and (
       exists (select 1 from sales_order o
                where o.client = s.client and o.order_number = s.sales_document and o.status = 'OPEN')
       or exists (select 1 from delivery dl
                where dl.client = s.client and dl.delivery_number = s.sales_document
                  and dl.status not in ('CANCELLED', 'GOODS_ISSUED'))
     );

\echo '=== PART A: open documents whose determination would change ==='

select p.client, p.customer, p.sales_document, p.document_date, p.order_currency, p.area_currency,
       p.order_value::text          as document_amount,
       p.rate::text                 as rate_used,
       round(p.order_value * p.rate, 4)::text as amount_in_area_currency,
       (p.basis_excluding_document + round(p.order_value * p.rate, 4))::text as converted_basis,
       p.credit_limit::text         as credit_limit,
       p.old_status,
       case
         when p.rate is null then 'REFUSED_NO_RATE'
         when p.credit_limit is null then 'BLOCK_NO_CREDIT_RECORD'
         when p.basis_excluding_document + round(p.order_value * p.rate, 4) > p.credit_limit then 'BLOCK_LIMIT_EXCEEDED'
         else 'PASS'
       end as new_verdict,
       case
         when p.rate is null then 'NO_RATE'
         when p.old_status = 'PASSED' and p.credit_limit is not null
           and p.basis_excluding_document + round(p.order_value * p.rate, 4) > p.credit_limit then 'PASSED -> BLOCKED'
         when p.old_status = 'BLOCKED' and p.credit_limit is not null
           and p.basis_excluding_document + round(p.order_value * p.rate, 4) <= p.credit_limit then 'BLOCKED -> PASSED'
         else 'unchanged'
       end as direction
  from imp_part_a p
 where (
   (p.rate is null)
   or (p.old_status = 'PASSED' and p.credit_limit is not null
       and p.basis_excluding_document + round(p.order_value * p.rate, 4) > p.credit_limit)
   or (p.old_status = 'BLOCKED' and p.credit_limit is not null
       and p.basis_excluding_document + round(p.order_value * p.rate, 4) <= p.credit_limit)
 )
 order by p.client, p.customer, p.document_date, p.sales_document;

\echo '=== PART A counts ==='

select case
         when p.rate is null then 'refused (no rate)'
         when p.credit_limit is null then 'blocked (no record)'
         when p.old_status = 'PASSED' and p.credit_limit is not null
           and p.basis_excluding_document + round(p.order_value * p.rate, 4) > p.credit_limit then 'PASSED -> BLOCKED'
         when p.old_status = 'BLOCKED' and p.credit_limit is not null
           and p.basis_excluding_document + round(p.order_value * p.rate, 4) <= p.credit_limit then 'BLOCKED -> PASSED'
         else 'unchanged'
       end as outcome,
       count(*) as documents
  from imp_part_a p
 group by 1
 order by 1;

\echo '=== PART B: open foreign-currency documents refused now (no rate, or a stale one) ==='

select s.client, s.customer, s.sales_document, s.document_date, s.order_currency,
       cca.currency as area_currency,
       s.order_value::text as document_amount,
       s.status as old_status,
       rt.valid_from::text as rate_date,
       case
         when rt.valid_from is null
           then 'No AVERAGE rate stands from ' || s.order_currency || ' to ' || cca.currency
                || ' on or before ' || s.document_date
         else 'The AVERAGE rate from ' || s.order_currency || ' to ' || cca.currency || ' in force on '
              || s.document_date || ' dates from ' || rt.valid_from || ', '
              || (s.document_date - rt.valid_from)::text || ' days old, which exceeds the '
              || ma.days || '-day maximum'
       end as refusal
  from imp_standing s
  join credit_control_area cca
    on cca.client = s.client and cca.credit_control_area = s.credit_control_area
  cross join (
    select coalesce((
      select (flags->>'CREDIT_MAX_RATE_AGE_DAYS')::int from client_settings
       where (:'client' = '' or client_settings.client = :'client') limit 1
    ), 45) as days
  ) ma
  cross join lateral (
    select coalesce(
      (select r.valid_from from exchange_rate r
        where r.client = s.client and r.rate_type = 'AVERAGE'
          and r.from_currency = s.order_currency and r.to_currency = cca.currency
          and r.valid_from <= s.document_date order by r.valid_from desc limit 1),
      (select r.valid_from from exchange_rate r
        where r.client = s.client and r.rate_type = 'AVERAGE'
          and r.from_currency = cca.currency and r.to_currency = s.order_currency
          and r.valid_from <= s.document_date order by r.valid_from desc limit 1)
    ) as valid_from
  ) rt
 where s.credit_control_area is not null
   and s.order_currency <> cca.currency
   and (
     rt.valid_from is null
     or (s.document_date - rt.valid_from) > ma.days
   )
 order by s.client, s.customer, s.document_date, s.sales_document;

-- Leave nothing behind: the views live only for this session, but drop them explicitly so a second run
-- in the same session starts clean.
drop view if exists imp_part_a;
drop view if exists imp_basis;
drop view if exists imp_bucket_converted;
drop view if exists imp_buckets;
drop view if exists imp_ar;
drop view if exists imp_standing;
