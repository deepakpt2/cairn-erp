-- 9287_distribution_cycles.sql
--
-- Distribution cycles (KSV5): the run of a cycle whose category is DISTRIBUTION.
-- A distribution preserves each sender's original G/L account, so it names no assessment account and
-- needs no CO_ASSESSMENT determination. The run row therefore carries the cycle's category, and its
-- assessment account is present for an assessment run and absent for a distribution run.
-- No new table. assessed_total keeps its name for both kinds (the amount relieved).
-- Also: the capability CO.DISTRIBUTION.EXECUTE (granted to no role), its registry entry, and the
-- KSV aliases (KSV1/KSV2/KSV3 beside KSU1/KSU2/KSU3 on the define entry; KSV5 on the new entry).

alter table public.cost_allocation_run add column if not exists category varchar(12);

update public.cost_allocation_run r
   set category = c.category
  from public.cost_allocation_cycle c
 where c.client = r.client and c.controlling_area = r.controlling_area and c.cycle_code = r.cycle_code
   and r.category is null;
-- Every run to date is an assessment (distribution was refused at run time).
update public.cost_allocation_run set category = 'ASSESSMENT' where category is null;

alter table public.cost_allocation_run alter column category set not null;
alter table public.cost_allocation_run alter column category set default 'ASSESSMENT';
alter table public.cost_allocation_run alter column assessment_account drop not null;

alter table public.cost_allocation_run drop constraint if exists cost_allocation_run_category_ck;
alter table public.cost_allocation_run add constraint cost_allocation_run_category_ck
  check (category in ('ASSESSMENT', 'DISTRIBUTION'));
alter table public.cost_allocation_run drop constraint if exists cost_allocation_run_account_ck;
alter table public.cost_allocation_run add constraint cost_allocation_run_account_ck
  check ((category = 'ASSESSMENT' and assessment_account is not null)
      or (category = 'DISTRIBUTION' and assessment_account is null));

-- ── Capability, granted to no role ──────────────────────────────────────────
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CO.DISTRIBUTION.EXECUTE', 'CO', 'EXECUTE', false,
   'Run a distribution cycle, relieving senders and charging receivers on the original G/L account (KSV5)')
on conflict (code) do nothing;

update public.term_registry
   set description = 'Define cost allocation cycles, assessment or distribution: segments with sender and receiver cost centres or groups, '
                  || 'and a receiver rule (percentage, portion or fixed amount).',
       changed_by = 'MIGRATION_9287', changed_at = now()
 where id = '9284a000-0000-4000-8000-000000000001';

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9287a000-0000-4000-8000-000000000001', 'CO.DISTRIBUTION.EXECUTE', null, 'Execute distribution',
       'TRANSACTION', 'CO',
       'Execute a distribution cycle for a period: preview, then post one AL document relieving senders and charging '
       || 'receivers on the original G/L account of each cost. No assessment account is used.',
       'TIER_1_BUILT', '/controlling/allocation-cycles', 'B', null, true, 'MIGRATION_9287', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9287a000-0000-4000-8000-000000000001' or r.our_code = 'CO.DISTRIBUTION.EXECUTE');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, v.term_id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9287', now()
  from (values
    ('9287b000-0000-4000-8000-000000000001', '9284a000-0000-4000-8000-000000000001', 'KSV1'),
    ('9287b000-0000-4000-8000-000000000002', '9284a000-0000-4000-8000-000000000001', 'KSV2'),
    ('9287b000-0000-4000-8000-000000000003', '9284a000-0000-4000-8000-000000000001', 'KSV3'),
    ('9287b000-0000-4000-8000-000000000004', '9287a000-0000-4000-8000-000000000001', 'KSV5')
  ) as v(id, term_id, alias)
 where exists (select 1 from public.term_registry r where r.id = v.term_id)
   and not exists (select 1 from public.term_alias a where a.id = v.id);
