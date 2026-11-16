-- 9292_stock_ageing_registry.sql
--
-- Stock ageing and slow-moving analysis (MC46 / MC50): the capability, the registry entry and its
-- two search aliases. Data only. No table, view, index or grant is added: the report reads
-- stock_quantity, material_document, material_document_line, movement_type, material and
-- material_valuation through the existing tenant RLS.
--
-- INV.STOCK.AGEING.DISPLAY follows CO.ORDER.COST.DISPLAY (9286): its own DISPLAY capability for a
-- report that carries values in currency, exact-grant-only in capability-policy.ts, granted to no role.

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('INV.STOCK.AGEING.DISPLAY', 'INV', 'DISPLAY', false,
   'Read the age of the stock on hand from the material ledger, and classify slow-moving and non-moving items (MC46 / MC50)')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9292a000-0000-4000-8000-000000000001', 'INV.STOCK.AGEING.DISPLAY', null,
       'Stock ageing', 'TRANSACTION', 'MM',
       'Age the stock on hand in FIFO layers rebuilt from the material ledger at material, plant and stock type, '
       || 'bucketed by days, with the last receipt and issue and a slow-moving / non-moving classification. '
       || 'Valued at the book price that stands today; read-only.',
       'TIER_1_BUILT', '/inventory/stock-ageing', 'B', null, true, 'MIGRATION_9292', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9292a000-0000-4000-8000-000000000001' or r.our_code = 'INV.STOCK.AGEING.DISPLAY');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9292a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9292', now()
  from (values
    ('9292b000-0000-4000-8000-000000000001', 'MC46'),
    ('9292b000-0000-4000-8000-000000000002', 'MC50')) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9292a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);
