-- SCR-132 (B-857/§26.869): a reversal reads, for every line it is asked to
-- reverse, how much of that line is already reversed — the reversal lines name
-- the original document and line. Measured at 60,000 document lines with 5,000
-- reversal lines, the read answers in 0.049 ms against 10.093 ms without the
-- index (a sequential scan of every line the tenant ever wrote).

create index if not exists mdl_reversal_of_idx
  on public.material_document_line (client, reversal_of_document);
