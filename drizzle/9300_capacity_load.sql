-- 9300_capacity_load.sql
--
-- Capacity load display (CM01). One nullable column on work_center_capacity, plus the capability, the registry
-- entry and the alias CM01.
-- The column has no foreign key on purpose: routing_standard_value_parameter is keyed by standard_value_key,
-- which lives on work_center, not on the capacity row. work-center.ts validates it.
-- Granted exactly as PROD.MRP.EXCEPTION (MD06) is: by the planner roles' PROD.* wildcard, in no role by name.

alter table public.work_center_capacity
  add column if not exists standard_value_parameter varchar(6);

comment on column public.work_center_capacity.standard_value_parameter is
  'Standard value parameter that loads this capacity. No foreign key: routing_standard_value_parameter is keyed by standard_value_key, which lives on work_center. Validated in work-center.ts.';

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PROD.CAPACITY.LOAD.DISPLAY', 'PROD', 'DISPLAY', false,
   'Display the capacity load of the work centers of a plant against their available capacity (CM01). Derived on every read; writes nothing')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9300a000-0000-4000-8000-000000000001', 'PROD.CAPACITY.LOAD.DISPLAY', null, 'Capacity load',
       'TRANSACTION', 'PP',
       'Work center capacity load: available capacity against the requirement derived from production and planned orders, by period. '
       || 'Recomputed on every execution; nothing is scheduled, levelled or written.',
       'TIER_1_BUILT', '/production/capacity-load', 'B', null, true, 'MIGRATION_9300', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9300a000-0000-4000-8000-000000000001' or r.our_code = 'PROD.CAPACITY.LOAD.DISPLAY');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9300b000-0000-4000-8000-000000000001', '9300a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', 'CM01', 'SEARCH_ONLY', 'MIGRATION_9300', now()
 where exists (select 1 from public.term_registry r where r.id = '9300a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9300b000-0000-4000-8000-000000000001');
