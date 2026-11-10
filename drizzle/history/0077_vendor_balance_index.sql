-- SCR-065 / R-113 (stage 2): vendor balances.
--
-- Balances create no table: they derive at read time from the posted
-- journal, so the report can never drift from the ledger. What the
-- round adds is the index the derivation walks: a supplier's partner
-- lines inside one company.
create index if not exists jel_partner_company_idx
  on public.journal_entry_line (client, business_partner, company_code);
