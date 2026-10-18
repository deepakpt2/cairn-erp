-- SCR-066 / R-114 (stage 2): vendor ageing.
--
-- Ageing stores nothing: standing as of a key date reconstructs from
-- the posted journal and its clearing stamps. The partner/company
-- line index already stands (0077); this adds the header walk by
-- company and posting date that the as-of reconstruction joins on.
create index if not exists je_company_posting_idx
  on public.journal_entry (client, company_code, posting_date);
