-- SCR-095 / R-143 (stage 2): indexes for the asset history sheet.
--
-- The sheet aggregates both transaction families by asset value
-- date within a company, and posted depreciation by fiscal year
-- and period. The per-asset indexes of SCR-092/093/094 already
-- serve drill paths; these composites serve the report's
-- date-bounded aggregation. No new tables: the sheet is a
-- read-only aggregation over canonical records.
create index asset_transaction_report_idx
  on public.asset_transaction (client, company_code, asset_value_date);
--> statement-breakpoint
create index asset_retirement_report_idx
  on public.asset_retirement (client, company_code, asset_value_date);
--> statement-breakpoint
create index asset_depreciation_posting_report_idx
  on public.asset_depreciation_posting (client, company_code, fiscal_year, posting_period);
