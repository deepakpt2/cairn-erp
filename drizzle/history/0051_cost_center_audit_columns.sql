-- SCR-041 / R-90 (stage 5 correction): the change-side audit pair.
--
-- Stage 2 created cost_center with created_by/created_at only, but the
-- schema definition (and every update the write performs) carries the
-- full audit set the platform requires (§7.4): changed_by/changed_at.
-- Append-only, as applied migrations are immutable.
alter table public.cost_center add column changed_by varchar(60);
--> statement-breakpoint
alter table public.cost_center add column changed_at timestamptz;
--> statement-breakpoint
