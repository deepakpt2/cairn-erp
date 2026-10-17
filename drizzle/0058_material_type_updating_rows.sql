-- SCR-048 / R-96 (stage 3): quantity/value updating lives only on the rows.
--
-- Stage 2 (0057) stood material_type_valuation per (type, plant) and
-- backfilled it from the type-level flags. The material services now
-- read the rows, so the flags on material_type retire.
alter table public.material_type drop column is_stocked;
--> statement-breakpoint
alter table public.material_type drop column is_valuated;
