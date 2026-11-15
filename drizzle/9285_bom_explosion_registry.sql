-- 9285_bom_explosion_registry.sql
--
-- BOM explosion and where-used (CS11 / CS12 / CS15): the registry entry and its search aliases.
-- Data only. No capability is added: the screen is a read of BOM master data and is guarded by the
-- standing PROD.BOM.DISPLAY. The registry code below names the screen, not an authority — as
-- PROD.MRP.SINGLE already does — so t-code search can find it.

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9285a000-0000-4000-8000-000000000001', 'PROD.BOM.EXPLOSION', null,
       'BOM explosion and where-used', 'TRANSACTION', 'PROD',
       'Explode a bill of material single-level or multi-level, with the quantities MRP would plan, or list every '
       || 'BOM a material is used in. Read-only; guarded by PROD.BOM.DISPLAY.',
       'TIER_1_BUILT', '/production/bom-explosion', 'B', null, true, 'MIGRATION_9285', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9285a000-0000-4000-8000-000000000001' or r.our_code = 'PROD.BOM.EXPLOSION');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9285a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9285', now()
  from (values
    ('9285b000-0000-4000-8000-000000000001', 'CS11'),
    ('9285b000-0000-4000-8000-000000000002', 'CS12'),
    ('9285b000-0000-4000-8000-000000000003', 'CS15')
  ) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9285a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);
