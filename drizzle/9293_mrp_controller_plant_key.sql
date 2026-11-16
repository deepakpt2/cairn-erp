-- 9293_mrp_controller_plant_key.sql
--
-- MRP controller maintenance (OMD0): the key of mrp_controller moves from (client, controller) to
-- (client, plant, controller), as SAP T024D and the neighbouring work_center table are keyed, and the
-- material's controller must stand IN ITS OWN PLANT.
--
-- Two deviations from the written order, both forced by the live schema:
--  * the primary key is named mrp_controller_client_controller_pk (not mrp_controller_pkey);
--  * material_plant's foreign key depends on that key, and the old key would reject the backfill
--    (same client and controller, different plant). The foreign key and the old key are therefore
--    dropped first, and the new foreign key is added last, after every row stands.
-- The whole file runs in one transaction; if the last step fails, nothing is applied.
--
-- No grant is made to any role.

-- 1. the dependent foreign key, by the name the catalogue holds (Postgres truncated it to 63 characters)
alter table public.material_plant
  drop constraint if exists material_plant_client_mrp_controller_mrp_controller_client_cont;

-- 2. the new column, nullable while it is filled; the old key goes so the backfill can coexist with the old rows
alter table public.mrp_controller add column if not exists plant varchar(10);
alter table public.mrp_controller drop constraint if exists mrp_controller_client_controller_pk;

-- 3. backfill from what materials actually reference: minimal, and guaranteed to satisfy the new foreign key
insert into public.mrp_controller (client, plant, controller, name, is_active, created_by, created_at)
select distinct mp.client, mp.plant, mp.mrp_controller, c.name, c.is_active, 'MIGRATION_9293', now()
  from public.material_plant mp
  join public.mrp_controller c
    on c.client = mp.client and c.controller = mp.mrp_controller and c.plant is null
 where mp.mrp_controller is not null;

-- 4. the client-level rows are the old seed, now superseded
delete from public.mrp_controller where plant is null;

-- 5. every row carries a plant
alter table public.mrp_controller alter column plant set not null;

-- 6. the primary key, and the plant itself must stand
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.mrp_controller'::regclass and contype = 'p') then
    alter table public.mrp_controller add constraint mrp_controller_pkey primary key (client, plant, controller);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mrp_controller_plant_fk'
                  and conrelid = 'public.mrp_controller'::regclass) then
    alter table public.mrp_controller
      add constraint mrp_controller_plant_fk
      foreign key (client, plant) references public.plant (client, plant);
  end if;
end $$;

-- 7. the material's controller stands in the material's own plant. Not relaxed: if this fails,
--    a material_plant row names a controller the backfill did not create.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'material_plant_mrp_controller_fk'
                  and conrelid = 'public.material_plant'::regclass) then
    alter table public.material_plant
      add constraint material_plant_mrp_controller_fk
      foreign key (client, plant, mrp_controller)
      references public.mrp_controller (client, plant, controller);
  end if;
end $$;

-- 8. capability, workbench route, registry entry and alias
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CFG.PROD.MRPCONTROLLER.DEFINE', 'PROD', 'CONFIGURE', false,
   'Define MRP controllers. The key is a plant and a code of at most three characters; the same code may stand in two plants. OMD0 is a search alias only. No material is planned.')
on conflict (code) do nothing;

update public.config_activity
   set route_path = '/config/mrp-controllers', changed_by = 'MIGRATION_9293', changed_at = now()
 where code = 'CFG.PROD.MRPCONTROLLER.DEFINE' and coalesce(route_path, '') = '';

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9293a000-0000-4000-8000-000000000001', 'CFG.PROD.MRPCONTROLLER.DEFINE', 'mrp_controller',
       'MRP controller', 'CONFIG_ACTIVITY', 'PROD',
       'The planner responsible for a material''s requirements in one plant. OMD0 is a search alias only. '
       || 'The key is a plant and a code of at most three characters, and the same code may stand in two '
       || 'plants with different names. A controller is named on the material master MRP view and is refused '
       || 'while materials carry it. This screen does not plan, does not run MRP, and does not send mail to '
       || 'the planner. T024D is this table.',
       'TIER_1_BUILT', '/config/mrp-controllers', 'B', null, true, 'MIGRATION_9293', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9293a000-0000-4000-8000-000000000001'
                       or r.our_code = 'CFG.PROD.MRPCONTROLLER.DEFINE');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9293b000-0000-4000-8000-000000000001', '9293a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'OMD0', 'SEARCH_ONLY', 'MIGRATION_9293', now()
 where exists (select 1 from public.term_registry r where r.id = '9293a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9293b000-0000-4000-8000-000000000001');
