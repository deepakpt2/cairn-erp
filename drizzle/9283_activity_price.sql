-- 9283_activity_price.sql
--
-- Activity price calculation (KSPI): the capability and its registry entry. Data only:
-- activity_rate already carries the price columns the calculation writes, and no table is
-- added or altered. The capability is granted to no role.

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CO.PLAN.ACTIVITYPRICE.EXECUTE', 'CO', 'EXECUTE', false,
   'Calculate activity prices from the plan (KSPI)')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9283a000-0000-4000-8000-000000000001', 'CO.PLAN.ACTIVITYPRICE.EXECUTE', 'activity_rate',
       'Activity price calculation', 'TRANSACTION', 'CO',
       'Calculate activity prices from the plan for activity types on price indicator 1: planned cost of the '
       || 'cost centre over planned activity quantity, previewed before it is written, with the rounding residual '
       || 'shown. Indicator 2 (capacity) is not calculable: the work centre master carries no cost centre. '
       || 'Indicator 3 (manual) is never touched.',
       'TIER_1_BUILT', '/config/activity-rates', 'B', null, true, 'MIGRATION_9283', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9283a000-0000-4000-8000-000000000001' or r.our_code = 'CO.PLAN.ACTIVITYPRICE.EXECUTE');

-- KSPI calculates and KSBT displays; both are the panel on the activity rate screen.
insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9283a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9283', now()
  from (values
    ('9283b000-0000-4000-8000-000000000001', 'KSPI'),
    ('9283b000-0000-4000-8000-000000000002', 'KSBT')
  ) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9283a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);
