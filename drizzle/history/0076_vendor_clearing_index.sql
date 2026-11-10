-- SCR-064 / R-112 (stage 2): vendor open-item clearing.
--
-- Clearing creates no new tables: the clearing journal is a standing
-- journal entry posted through the posting engine, and the cleared
-- state lives on the standing journal lines (clearing_document,
-- clearing_date). What the round adds is the index the open-item
-- selection walks: a supplier's partner lines by their cleared state.
create index if not exists jel_partner_open_idx
  on public.journal_entry_line (client, business_partner, clearing_document);
