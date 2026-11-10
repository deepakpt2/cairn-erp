-- ── The cascade 9261 omitted ─────────────────────────────────────────────────
--
-- 9261 created `serial_number` and `delivery_picking_serial` with a foreign key
-- to `client` that carries no `on delete cascade`. Every other tenant table in
-- this canon cascades, and the tests rely on it: `destroyTenant` deletes the
-- client row and expects the tenant's data to go with it. Without the cascade a
-- tenant holding a single serial row cannot be deleted at all.
--
-- The correct way to fix a migration is to edit it before it is applied; 9261 was
-- applied first, and the migrator is right to refuse a file that no longer matches
-- what it ran. So the correction goes here, and 9261 is left exactly as it stands.
--
-- Both statements are written to be safe wherever they land: the constraint is
-- dropped and recreated, so a database that already cascades is unchanged.

alter table serial_number
  drop constraint if exists serial_number_client_fkey;

alter table serial_number
  add constraint serial_number_client_fkey
  foreign key (client) references client (client) on delete cascade;

alter table delivery_picking_serial
  drop constraint if exists delivery_picking_serial_client_fkey;

alter table delivery_picking_serial
  add constraint delivery_picking_serial_client_fkey
  foreign key (client) references client (client) on delete cascade;
