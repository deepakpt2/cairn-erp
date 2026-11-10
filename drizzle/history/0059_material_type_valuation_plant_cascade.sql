-- SCR-048 / R-96 (stage 3): updating rows belong to their plant.
--
-- The standard-structure builder deletes and rebuilds the plant row;
-- per-plant updating rows are plant-scoped configuration, so they
-- cascade with the plant instead of blocking its deletion.
alter table public.material_type_valuation
  drop constraint material_type_valuation_plant_fk;
--> statement-breakpoint
alter table public.material_type_valuation
  add constraint material_type_valuation_plant_fk foreign key (client, valuation_area)
  references public.plant (client, plant) on delete cascade;
