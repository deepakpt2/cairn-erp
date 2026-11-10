-- SCR-088 / R-136 (stage 2): reporting indexes for the G/L line
-- item report. Indexes only — the report reads the canonical
-- journal and creates no tables of its own.
create index if not exists journal_entry_company_posting_idx
  on public.journal_entry (client, company_code, posting_date, document_number);
--> statement-breakpoint
create index if not exists jel_company_account_idx
  on public.journal_entry_line (client, company_code, gl_account, fiscal_year, document_number, line_number);
