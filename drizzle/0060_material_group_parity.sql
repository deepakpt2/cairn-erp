-- SCR-049 / R-97 (stage 2): material groups take the OMSF parity shape.
--
-- The material_group table already stands from the materials build
-- with a 20-character key and a single 100-character name. Parity
-- (R-97) narrows it in place: the key to nine characters (the one
-- provisioned key exceeding it, MAINTENANCE, renamed MAINT wherever
-- materials carry it), the name to the 20-character short description,
-- and an optional 60-character long description on the row, seeded for
-- the provisioned descriptions the narrowing truncates.
alter table public.material
  drop constraint material_client_material_group_material_group_client_material_g;
--> statement-breakpoint
update public.material set material_group = 'MAINT' where material_group = 'MAINTENANCE';
--> statement-breakpoint
update public.material_group set material_group = 'MAINT' where material_group = 'MAINTENANCE';
--> statement-breakpoint
alter table public.material
  add constraint material_client_material_group_material_group_client_material_g
  foreign key (client, material_group)
  references public.material_group (client, material_group);
--> statement-breakpoint
alter table public.material_group add column long_description varchar(60);
--> statement-breakpoint
update public.material_group
  set long_description = name, name = 'Manufactured goods'
  where material_group = 'PRODUCTS' and length(name) > 20;
--> statement-breakpoint
update public.material_group
  set long_description = name, name = 'Maintenance'
  where material_group = 'MAINT';
--> statement-breakpoint
alter table public.material_group alter column material_group type varchar(9);
--> statement-breakpoint
alter table public.material_group alter column name type varchar(20);
