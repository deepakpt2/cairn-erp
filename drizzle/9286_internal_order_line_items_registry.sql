-- 9286_internal_order_line_items_registry.sql
--
-- Internal order line items (KOB1): the capability, the registry entry and its search alias.
-- Data only. No table, view, index or grant is added: the report reads journal_entry_line and
-- journal_entry through the existing tenant RLS.
--
-- CO.ORDER.COST.DISPLAY follows PROD.ORDER.COST.DISPLAY exactly: its own DISPLAY capability for a
-- report that carries amounts, exact-grant-only in capability-policy.ts, and granted to no role.

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CO.ORDER.COST.DISPLAY', 'CO', 'DISPLAY', false,
   'Read the actual journal line items posted to one internal order (KOB1). Writes nothing')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9286a000-0000-4000-8000-000000000001', 'CO.ORDER.COST.DISPLAY', null,
       'Internal order line items', 'TRANSACTION', 'CO',
       'List the actual journal lines posted to one internal order (POSTED and REVERSED documents; never parked), '
       || 'filtered by fiscal year, period and cost element, with debits, credits and net per currency. A net in the '
       || 'order currency is stated only when every line is in that currency. Read-only.',
       'TIER_1_BUILT', '/controlling/internal-order-line-items', 'B', null, true, 'MIGRATION_9286', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9286a000-0000-4000-8000-000000000001' or r.our_code = 'CO.ORDER.COST.DISPLAY');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9286b000-0000-4000-8000-000000000001', '9286a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'KOB1', 'SEARCH_ONLY', 'MIGRATION_9286', now()
 where exists (select 1 from public.term_registry r where r.id = '9286a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9286b000-0000-4000-8000-000000000001');
