-- Add nominal_value to inspection_characteristic so tolerances can be evaluated
-- relative to a target rather than as absolute bounds. Existing rows default to 0.
alter table public.inspection_characteristic
  add column if not exists nominal_value numeric(13, 4) not null default 0;
