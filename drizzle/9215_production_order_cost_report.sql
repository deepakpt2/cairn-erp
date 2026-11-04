-- Read-only production-order actual-posting report.
-- The view contains only posted/reversed journal lines assigned to a production order.
-- SECURITY INVOKER preserves the tenant RLS policies of the base journal tables.

CREATE INDEX IF NOT EXISTS journal_entry_line_production_order_idx
  ON public.journal_entry_line (client, production_order, document_number, fiscal_year, line_number)
  WHERE production_order IS NOT NULL;

CREATE VIEW public.production_order_actual_posting_v
WITH (security_invoker = true)
AS
SELECT
  l.client,
  l.production_order AS order_number,
  j.company_code,
  j.document_number,
  j.display_number,
  j.fiscal_year,
  j.document_type,
  j.document_date,
  j.posting_date,
  j.posting_period,
  j.document_currency,
  j.local_currency,
  j.status AS document_status,
  j.reversal_of,
  j.reversed_by,
  j.origin_class,
  j.origin_key,
  l.line_number,
  l.gl_account,
  l.debit_credit,
  l.amount_document,
  l.amount_local,
  l.currency AS line_currency,
  l.material,
  l.plant,
  l.line_text
FROM public.journal_entry_line l
JOIN public.journal_entry j
  ON j.client = l.client
 AND j.document_number = l.document_number
 AND j.fiscal_year = l.fiscal_year
WHERE l.production_order IS NOT NULL
  AND j.status IN ('POSTED', 'REVERSED');

COMMENT ON VIEW public.production_order_actual_posting_v IS
  'Read-only ledger lines assigned to production orders. Amounts are journal actuals, not activity-rate estimates; read through a security-invoker view so base-table tenant RLS applies.';

REVOKE ALL ON TABLE public.production_order_actual_posting_v FROM PUBLIC;
GRANT SELECT ON TABLE public.production_order_actual_posting_v TO cairn_app;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'PROD.ORDER.COST.DISPLAY', 'PROD', 'DISPLAY', false,
  'Read posted journal actuals assigned to one production order. The report writes nothing and does not value confirmation activities, calculate WIP, or categorize variance.'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.ORDER.COST.DISPLAY',
  NULL,
  'Production order cost report',
  'TRANSACTION',
  'PROD',
  'Read posted journal debits, credits, and net balance assigned to a production order. Confirmed activity quantities are not monetarily valued; plan rates are not actuals. No WIP, variance categorization, or posting is performed.',
  'TIER_1_BUILT',
  '/production/order-cost-report',
  'B',
  'MIGRATION_9215'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9215',
  changed_at = now();
