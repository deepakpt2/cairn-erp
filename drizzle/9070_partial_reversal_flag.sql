-- SCR-132 (B-857/§26.869): 0073 tied the reversal link to a status of POSTED or
-- REVERSED — a document either named its reverser or did not. A document may now
-- stand partly reversed, so a document that names its reverser may also be
-- PARTIALLY_REVERSED. The link still requires a status: an unreversed document
-- carries neither a reverser nor a partial state.

alter table public.material_document
  drop constraint if exists material_document_reversal_ck;
alter table public.material_document
  add constraint material_document_reversal_ck check (
    (reversal_of is null and reversed_by is null)
    or status in ('POSTED', 'PARTIALLY_REVERSED', 'REVERSED')
  );
