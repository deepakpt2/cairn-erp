-- SCR-053 / R-101 (stage 2): material deletion flags (MM06).
--
-- The deletion indicator at the two scopes Cairn holds: the material
-- itself (client level) and each plant record. A flag marks its scope
-- as intended for deletion; it deletes nothing, locks nothing, and can
-- be cancelled — archiving and physical deletion are a separate,
-- deferred process (R-101). Standing rows start unflagged.
alter table public.material add column marked_for_deletion boolean not null default false;
--> statement-breakpoint
alter table public.material_plant add column marked_for_deletion boolean not null default false;
