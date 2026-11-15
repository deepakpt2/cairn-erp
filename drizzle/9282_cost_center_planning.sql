-- 9282_cost_center_planning.sql
--
-- Cost centre planning (KP06): the capability and its registry entry. Data only:
-- cost_center_plan already stands and is not altered, and no table is added.
-- The capability is granted to no role.

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CO.PLAN.COSTCENTER.MAINTAIN', 'CO', 'MAINTAIN', false,
   'Plan primary costs per cost centre, cost element and period (KP06)')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9282a000-0000-4000-8000-000000000001', 'CO.PLAN.COSTCENTER.MAINTAIN', 'cost_center_plan',
       'Cost centre planning', 'TRANSACTION', 'CO',
       'Plan primary costs per cost centre, cost element and period, by plan version and fiscal year. '
       || 'An annual total can be spread over the periods. The actual/plan report reads what is saved here.',
       'TIER_1_BUILT', '/controlling/cost-center-planning', 'B', null, true, 'MIGRATION_9282', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9282a000-0000-4000-8000-000000000001' or r.our_code = 'CO.PLAN.COSTCENTER.MAINTAIN');

-- KP06 changes the plan and KP07 displays it; here both are the same screen.
insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9282a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9282', now()
  from (values
    ('9282b000-0000-4000-8000-000000000001', 'KP06'),
    ('9282b000-0000-4000-8000-000000000002', 'KP07')
  ) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9282a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);
