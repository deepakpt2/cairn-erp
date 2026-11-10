-- ── The shipping point determination rule has to go with its plant ────────────
--
-- 9245 created `shipping_point_determination` with `on delete restrict` on both
-- of its foreign keys — the one to `plant` and the one to `shipping_point`. The
-- intent was sound: a rule that answers "which dock loads this plant" should not
-- survive the plant it answers for, and restrict stops a plant being deleted out
-- from under a rule that still names it.
--
-- The cost is that a tenant that has configured shipping point determination
-- cannot be deleted at all. Deleting a client cascades to `plant` and to
-- `shipping_point`, and both restricts then refuse the delete. `destroyTenant`
-- fails, the tenant is left standing, and the next run's cleanup — which removes
-- stale test tenants by deleting from `client` — fails on the leftover in turn,
-- so one leaked tenant takes a following test file down with it.
--
-- This is the same mistake as 9261 and it has the same shape of correction: the
-- rule belongs to the plant and to the shipping point, and when either goes the
-- rule is meaningless. Cascade is what the rest of the tenant tables in this
-- canon do, and a tenant that cannot be deleted is a worse outcome than a rule
-- that disappears with the plant it described.
--
-- Both foreign keys are dropped by column rather than by name, because the name
-- postgres generated in 9245 is not the obvious one and dropping a misspelled
-- name silently adds a second, duplicate constraint instead of changing the
-- first. Dropping every constraint that spans the column pair is exact, and
-- leaves nothing behind whatever a given database happens to call it today.

do $$
declare
  dropped record;
begin
  for dropped in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'shipping_point_determination'::regclass
       and con.contype = 'f'
       and (
         (
           array_length(con.conkey, 1) = 2
           and (
             select array_agg(att.attname::text order by att.attname)
               from pg_attribute att
              where att.attrelid = con.conrelid
                and att.attnum = any(con.conkey)
           ) = array['client', 'delivering_plant']
         )
         or (
           array_length(con.conkey, 1) = 2
           and (
             select array_agg(att.attname::text order by att.attname)
               from pg_attribute att
              where att.attrelid = con.conrelid
                and att.attnum = any(con.conkey)
           ) = array['client', 'shipping_point']
         )
       )
  loop
    execute format(
      'alter table shipping_point_determination drop constraint %I',
      dropped.conname
    );
  end loop;
end
$$;

alter table shipping_point_determination
  add constraint shipping_point_determination_client_delivering_plant_fkey
  foreign key (client, delivering_plant) references plant (client, plant) on delete cascade;

alter table shipping_point_determination
  add constraint shipping_point_determination_client_shipping_point_fkey
  foreign key (client, shipping_point) references shipping_point (client, shipping_point) on delete cascade;
