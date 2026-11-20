-- 9315_currency_precision.sql
--
-- Currency precision. A currency has the decimals its `currency.decimal_places` says (KWD: 3), so a unit price
-- or a document value stored with two decimals would silently lose the third. These columns held two:
--
--   purchase_order_item        net_price (11,2)  net_value (13,2)
--   purchase_contract_item     net_price (11,2)  net_value (15,2)     purchase_contract.target_value (15,2)
--   scheduling_agreement_item  net_price (11,2)  net_value (15,2)
--   purchase_requisition_item  estimated_price (11,2)
--   employee_tolerance_group   max_document_amount, max_line_amount, payment_diff_{expense,revenue}_amount
--
-- Prices widen to numeric(13,4): a unit price may carry more decimals than the currency's minor unit (it is only
-- rounded to the minor unit when it becomes a posted value). Values and tolerance amounts widen to numeric(23,4),
-- the scale of every other monetary column. Widening is lossless: every stored value keeps its exact digits and
-- gains trailing zeros. Nothing already posted is rewritten, and a value that was rounded to two decimals before
-- this migration cannot be reconstructed (the lost digit was never stored).
--
-- Not changed: payroll and journal columns (already numeric(23,4)), quantity columns, percentages.

alter table public.purchase_order_item
  alter column net_price type numeric(13,4),
  alter column net_value type numeric(23,4);

alter table public.purchase_contract_item
  alter column net_price type numeric(13,4),
  alter column net_value type numeric(23,4);

alter table public.purchase_contract
  alter column target_value type numeric(23,4);

alter table public.scheduling_agreement_item
  alter column net_price type numeric(13,4),
  alter column net_value type numeric(23,4);

alter table public.purchase_requisition_item
  alter column estimated_price type numeric(13,4);

alter table public.employee_tolerance_group
  alter column max_document_amount type numeric(23,4),
  alter column max_line_amount type numeric(23,4),
  alter column payment_diff_expense_amount type numeric(23,4),
  alter column payment_diff_revenue_amount type numeric(23,4);
