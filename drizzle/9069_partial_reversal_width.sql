-- SCR-132 (B-857/§26.869): PARTIALLY_REVERSED is eighteen characters and the
-- status column was ten wide. The check was widened in 9067; the column follows.

alter table public.material_document
  alter column status type varchar(20);
