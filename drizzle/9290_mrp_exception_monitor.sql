-- 9290_mrp_exception_monitor.sql
--
-- MRP exception monitor (MD06): registry only. The capability PROD.MRP.EXCEPTION, its registry entry on the
-- new route and the alias MD06. No table and no schema change: the monitor reads the stock/requirements list
-- (MD04) for each planned material and collects the materials that carry an exception.
-- Granted exactly as PROD.MRP.STOCKREQ (MD04) is: by the planner roles' PROD.* wildcard, in no role by name.

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PROD.MRP.EXCEPTION', 'PROD', 'DISPLAY', false,
   'Display the MRP exception monitor: every planned material of a plant that has a shortage, a safety stock breach or a past-due element (MD06). Reads only')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9290a000-0000-4000-8000-000000000001', 'PROD.MRP.EXCEPTION', null, 'MRP exception monitor',
       'TRANSACTION', 'PROD',
       'List the materials of a plant that MRP plans and that carry an exception — shortage, safety stock breach, past due — '
       || 'ordered by urgency, each drilling to the stock/requirements list. Recomputed on every execution; nothing is planned or written.',
       'TIER_1_BUILT', '/production/mrp-exception-monitor', 'B', null, true, 'MIGRATION_9290', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9290a000-0000-4000-8000-000000000001' or r.our_code = 'PROD.MRP.EXCEPTION');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9290b000-0000-4000-8000-000000000001', '9290a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', 'MD06', 'SEARCH_ONLY', 'MIGRATION_9290', now()
 where exists (select 1 from public.term_registry r where r.id = '9290a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9290b000-0000-4000-8000-000000000001');
