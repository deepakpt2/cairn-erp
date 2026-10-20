-- SCR-125 (B-835/§26.847): the material document list (MB51) requires a
-- posting-date range and reads newest first. Measured at 20,000 documents and
-- 60,000 lines, the walk from that date index answers the broad selection in
-- 3.0 ms against 71.7 ms without it, and the plant selection in 4.3 ms against
-- 36.1 ms. One index, on the header alone: plant and material stand on the
-- line, where material_number already carries material_document_line_material_idx,
-- and the composite the package recommends cannot span the two tables.

create index if not exists md_posting_date_idx
  on public.material_document (client, posting_date);
