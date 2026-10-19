-- SCR-113 / R-161 (stage 2): profit-centre line-item path.
-- KE5Z reads POSTED journal lines by tenant, profit centre and
-- fiscal year (company rides the line for the header join).
-- No new tables: the journal stays the single actuals source.
create index jel_profitcenter_idx
  on public.journal_entry_line (client, profit_center, fiscal_year, company_code);
